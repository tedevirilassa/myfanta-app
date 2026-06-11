/**
 * scripts/backup-db.js
 *
 * Esporta tutte le tabelle del database in file JSON nella cartella backups/.
 * Ogni backup crea una sotto-cartella con timestamp.
 *
 * Uso:
 *   node scripts/backup-db.js                 → backup DEV (default)
 *   node scripts/backup-db.js --env dev        → backup DEV
 *   node scripts/backup-db.js --env prod       → backup PROD via SSH tunnel
 *   node scripts/backup-db.js --out <dir>      → cartella di output personalizzata
 *
 * REGOLA: ogni volta che si aggiunge/modifica/elimina una tabella o colonna
 *         aggiornare TABLES (backup-db.js) e TABLES_ORDER (restore-db.js).
 */

"use strict";

require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const net  = require("net");
const { Client } = require("ssh2");
const { Pool }   = require("pg");

const TUNNEL_LOCAL_PORT = 5455; // porta separata da sync-to-prod (5454) per evitare conflitti

// ─── Config SSH prod ──────────────────────────────────────────────────────────

function extractHost(connStr) {
  try { return new URL(connStr).hostname; } catch { return null; }
}

const DATABASE_URL      = process.env.DATABASE_URL;
const DATABASE_URL_PROD = process.env.DATABASE_URL_PROD;
const SSH_HOST          = process.env.PROD_SSH_HOST || extractHost(DATABASE_URL_PROD) || "fantaserver";
const SSH_PORT          = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER          = process.env.PROD_SSH_USER || "fantauser";
const SSH_PASS          = process.env.PROD_SSH_PASSWORD;
const REMOTE_DB_HOST    = process.env.PROD_DB_REMOTE_HOST || "localhost";
const REMOTE_DB_PORT    = 5432;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[backup] ${msg}`);
}

// ─── Tunnel SSH ───────────────────────────────────────────────────────────────

function buildTunnelUrl(originalUrl) {
  try {
    const u = new URL(originalUrl);
    u.hostname = "127.0.0.1";
    u.port     = String(TUNNEL_LOCAL_PORT);
    return u.toString();
  } catch {
    return originalUrl.replace(/@[^/]+\//, `@127.0.0.1:${TUNNEL_LOCAL_PORT}/`);
  }
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    const conn   = new Client();
    const server = net.createServer((socket) => {
      conn.forwardOut("127.0.0.1", 0, REMOTE_DB_HOST, REMOTE_DB_PORT, (err, channel) => {
        if (err) { socket.destroy(); return; }
        socket.pipe(channel).pipe(socket);
        socket.on("error",  () => channel.destroy());
        channel.on("error", () => socket.destroy());
        channel.on("close", () => socket.destroy());
        socket.on("close",  () => channel.destroy());
      });
    });
    server.on("error", (err) => reject(new Error(`Tunnel server: ${err.message}`)));
    conn.on("ready", () => {
      server.listen(TUNNEL_LOCAL_PORT, "127.0.0.1", () => {
        log(`Tunnel SSH attivo: 127.0.0.1:${TUNNEL_LOCAL_PORT} → ${REMOTE_DB_HOST}:${REMOTE_DB_PORT}`);
        resolve({ conn, server });
      });
    });
    conn.on("error", (err) => { server.close(); reject(new Error(`SSH: ${err.message}`)); });
    conn.connect({ host: SSH_HOST, port: SSH_PORT, username: SSH_USER, password: SSH_PASS, readyTimeout: 20000 });
  });
}

// ─── Tabelle da esportare (ordinate per rispettare le FK) ────────────────────

const TABLES = [
  {
    name: "fantapresidenti",
    query: `SELECT id, email, "passwordHash", role, "isActive", "mustChangePassword",
                   nickname, "invitedById", "createdAt", "updatedAt"
            FROM fantapresidenti ORDER BY id`,
  },
  {
    name: "fanta_teams",
    query: `SELECT id, nome, "userId", "createdAt", "updatedAt"
            FROM fanta_teams ORDER BY id`,
  },
  {
    name: "giocatori",
    query: `SELECT id, nome, "ruoloEsteso", ruolo, squadra, eta,
                   "anniContratto", valore, "dataNascita", nazionalita,
                   "transfermarktId", active, "createdAt", "updatedAt"
            FROM giocatori ORDER BY id`,
  },
  {
    name: "quotazioni",
    query: `SELECT id, "giocatoreId", valore, fonte, "createdAt"
            FROM quotazioni ORDER BY id`,
  },
  {
    name: "contratti",
    query: `SELECT id, tipo, clausola, "dataStipula", "durataContratto",
                   "dataFine", "giocatoreId", "fantaTeamId",
                   "valoreGiocatore", "importoOperazione", "prezzoAcquisto",
                   provenienza, destinazione, valido, "createdAt", "updatedAt"
            FROM contratti ORDER BY id`,
  },
  {
    name: "situazione_finanziaria",
    query: `SELECT id, "nomePresidente", "valoreRose", crediti,
                   patrimonio, "giocatoriTesserati", "etaMedia", stipendi,
                   "montePrestiti", "ultimoPlusMinus", "fantaTeamId",
                   "createdAt", "updatedAt"
            FROM situazione_finanziaria ORDER BY id`,
  },
  {
    name: "rosa_giocatori",
    query: `SELECT id, "fantaTeamId", "giocatoreId", categoria,
                   "createdAt", "updatedAt"
            FROM rosa_giocatori ORDER BY id`,
  },
  {
    name: "parametri",
    query: `SELECT id, chiave, valore, descrizione, "createdAt", "updatedAt"
            FROM parametri ORDER BY id`,
  },
  {
    name: "log_azioni",
    query: `SELECT id, azione, entita, "entitaId", dettaglio, "adminId", "createdAt"
            FROM log_azioni ORDER BY id`,
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const envIdx = args.indexOf("--env");
  const env    = envIdx !== -1 ? args[envIdx + 1] : "dev";

  if (!["dev", "prod"].includes(env)) {
    console.error(`--env deve essere 'dev' o 'prod' (ricevuto: '${env}')`);
    process.exit(1);
  }

  const isProd = env === "prod";

  // Cartella di output
  const outIdx = args.indexOf("--out");
  const baseDir = outIdx !== -1 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : path.resolve(__dirname, "../backups");

  // Timestamp per sotto-cartella
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`
            + `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const backupDir = path.join(baseDir, `${ts}_${env}`);

  // ── Connessione ──────────────────────────────────────────────────────────
  let tunnel = null;
  let pool;

  if (isProd) {
    if (!DATABASE_URL_PROD) { console.error("DATABASE_URL_PROD mancante in .env"); process.exit(1); }
    if (!SSH_PASS)          { console.error("PROD_SSH_PASSWORD mancante in .env"); process.exit(1); }
    log("Apertura tunnel SSH verso PROD...");
    tunnel = await startTunnel();
    const tunnelUrl = buildTunnelUrl(DATABASE_URL_PROD);
    pool = new Pool({ connectionString: tunnelUrl, ssl: false });
  } else {
    if (!DATABASE_URL) { console.error("DATABASE_URL mancante in .env"); process.exit(1); }
    pool = new Pool({ connectionString: DATABASE_URL, ssl: false });
  }

  try {
    await pool.query("SELECT 1");
    log(`Connesso al DB ${env.toUpperCase()}`);
  } catch (e) {
    console.error(`Impossibile connettersi al DB ${env}:`, e.message);
    if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
    process.exit(1);
  }

  // Crea la cartella di backup
  fs.mkdirSync(backupDir, { recursive: true });
  log(`Cartella backup: ${backupDir}`);

  const summary = {};

  try {
    for (const table of TABLES) {
      log(`Esporto ${table.name}...`);
      try {
        const { rows } = await pool.query(table.query);
        summary[table.name] = rows.length;
        const filePath = path.join(backupDir, `${table.name}.json`);
        fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), "utf8");
        log(`  ✔ ${rows.length} righe → ${table.name}.json`);
      } catch (err) {
        log(`  ⚠ Errore su ${table.name}: ${err.message}`);
        summary[table.name] = "ERRORE";
      }
    }

    // Riepilogo
    const summaryPath = path.join(backupDir, "_summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify({
      timestamp: now.toISOString(),
      env,
      tables: summary,
    }, null, 2), "utf8");

    console.log(`\n${"═".repeat(50)}`);
    console.log(`  Backup ${env.toUpperCase()} completato`);
    console.log("═".repeat(50));
    console.log(`  📁 ${backupDir}`);
    for (const [t, count] of Object.entries(summary)) {
      const icon = count === "ERRORE" ? "❌" : "✔";
      console.log(`  ${icon} ${t}: ${count === "ERRORE" ? "errore" : count + " righe"}`);
    }
    console.log();
  } catch (err) {
    console.error("\nERRORE durante il backup:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
    if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
  }
}

main();
