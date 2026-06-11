/**
 * scripts/restore-db.js
 *
 * Ripristina il DB da una cartella di backup prodotta da scripts/backup-db.js.
 * Mostra l'elenco dei backup disponibili, fa scegliere quale, chiede conferma,
 * poi TRUNCATE + INSERT in ordine FK e reset delle sequence.
 *
 * Uso:
 *   node scripts/restore-db.js                    → menu interattivo, backup DEV
 *   node scripts/restore-db.js --env dev           → menu interattivo, backup DEV
 *   node scripts/restore-db.js --env prod          → menu interattivo, backup PROD (via SSH tunnel)
 *   node scripts/restore-db.js --all               → mostra backup di tutti gli env
 *   node scripts/restore-db.js --dir <path>        → restore non-interattivo da cartella specifica
 *   node scripts/restore-db.js --yes               → skip conferma finale (USARE CON CAUTELA)
 *
 * ⚠ ATTENZIONE: operazione DISTRUTTIVA. Tutte le tabelle in TABLES_ORDER vengono
 *   svuotate (TRUNCATE ... RESTART IDENTITY CASCADE) e ripopolate dai file JSON.
 *
 * REGOLA: ogni volta che si aggiunge/modifica/elimina una tabella o colonna
 *         aggiornare TABLES (backup-db.js) e TABLES_ORDER (restore-db.js).
 */

"use strict";

require("dotenv").config();

const fs       = require("fs");
const path     = require("path");
const net      = require("net");
const readline = require("readline");
const { Client } = require("ssh2");
const { Pool }   = require("pg");

const TUNNEL_LOCAL_PORT = 5455;

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

// ─── ordine FK ────────────────────────────────────────────────────────────────
// Ordine di inserimento (parent → child). TRUNCATE usa CASCADE quindi l'ordine
// di svuotamento non importa.

const TABLES_ORDER = [
  "fantapresidenti",
  "fanta_teams",
  "giocatori",
  "quotazioni",
  "contratti",
  "situazione_finanziaria",
  "rosa_giocatori",
  "parametri",
  "log_azioni",
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[restore] ${msg}`);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function dirSize(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isFile()) total += s.size;
  }
  return total;
}

function readSummary(dir) {
  const sp = path.join(dir, "_summary.json");
  if (!fs.existsSync(sp)) return null;
  try { return JSON.parse(fs.readFileSync(sp, "utf8")); }
  catch { return null; }
}

function listBackups(baseDir, envFilter, includeAll) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir)
    .map(name => ({ name, full: path.join(baseDir, name) }))
    .filter(e => fs.statSync(e.full).isDirectory());

  const items = [];
  for (const e of entries) {
    const summary = readSummary(e.full);
    // Supporta sia il vecchio formato (source: locale/render) che il nuovo (env: dev/prod)
    const rawEnv = summary?.env || summary?.source || null;
    const detectedEnv =
      rawEnv === "locale" ? "dev" :
      rawEnv === "render" ? "prod" :
      rawEnv || (e.name.includes("prod") ? "prod" : "dev");

    if (!includeAll && detectedEnv !== envFilter) continue;
    items.push({
      name:      e.name,
      full:      e.full,
      timestamp: summary?.timestamp || null,
      env:       detectedEnv,
      size:      dirSize(e.full),
      tables:    summary?.tables || null,
    });
  }
  items.sort((a, b) => (a.name < b.name ? 1 : -1));
  return items;
}

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, ans => resolve(ans.trim())));
}

// ─── restore core ────────────────────────────────────────────────────────────

async function restoreFromDir(pool, backupDir) {
  // Carica tutti i file JSON disponibili
  const data = {};
  for (const t of TABLES_ORDER) {
    const fp = path.join(backupDir, `${t}.json`);
    if (!fs.existsSync(fp)) {
      log(`  ⚠ ${t}.json mancante → tabella verrà solo svuotata`);
      data[t] = [];
      continue;
    }
    try {
      data[t] = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (!Array.isArray(data[t])) throw new Error("non è un array");
    } catch (err) {
      throw new Error(`Parse fallito per ${t}.json: ${err.message}`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // TRUNCATE con CASCADE per ignorare ordine FK in cancellazione
    const truncList = TABLES_ORDER.map(t => `"${t}"`).join(", ");
    log(`TRUNCATE ${truncList}`);
    await client.query(`TRUNCATE ${truncList} RESTART IDENTITY CASCADE`);

    // INSERT in ordine FK
    let totalInserted = 0;
    for (const table of TABLES_ORDER) {
      const rows = data[table];
      if (!rows || rows.length === 0) {
        log(`  - ${table}: 0 righe`);
        continue;
      }

      const columns = Object.keys(rows[0]);
      const colSql  = columns.map(c => `"${c}"`).join(", ");

      for (const row of rows) {
        const values = columns.map(c => {
          const v = row[c];
          if (v === undefined || v === null) return null;
          // Colonne jsonb (es. log_azioni.dettaglio) tornano come oggetto da pg
          // dopo il backup. Re-serializziamo prima dell'INSERT.
          if (typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
          return v;
        });
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(
          `INSERT INTO "${table}" (${colSql}) VALUES (${placeholders})`,
          values
        );
      }

      // Reset sequence id (se la tabella ha colonna id seriale)
      if (columns.includes("id")) {
        await client.query(
          `SELECT setval(
             pg_get_serial_sequence($1, 'id'),
             COALESCE((SELECT MAX(id) FROM "${table}"), 1),
             (SELECT MAX(id) IS NOT NULL FROM "${table}")
           )`,
          [table]
        );
      }

      log(`  ✔ ${table}: ${rows.length} righe inserite`);
      totalInserted += rows.length;
    }

    await client.query("COMMIT");
    log(`Commit OK. Totale righe inserite: ${totalInserted}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args        = process.argv.slice(2);
  const envIdx      = args.indexOf("--env");
  const envTarget   = envIdx !== -1 ? args[envIdx + 1] : "dev";
  const includeAll  = args.includes("--all");
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  const dirIdx      = args.indexOf("--dir");
  const explicitDir = dirIdx !== -1 ? args[dirIdx + 1] : null;

  if (!["dev", "prod"].includes(envTarget)) {
    console.error(`--env deve essere 'dev' o 'prod' (ricevuto: '${envTarget}')`);
    process.exit(1);
  }

  const isProd = envTarget === "prod";

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
    log(`Connesso al DB ${envTarget.toUpperCase()}`);
  } catch (e) {
    console.error(`Impossibile connettersi al DB ${envTarget}:`, e.message);
    if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
    process.exit(1);
  }

  let chosenDir;

  if (explicitDir) {
    chosenDir = path.resolve(explicitDir);
    if (!fs.existsSync(chosenDir) || !fs.statSync(chosenDir).isDirectory()) {
      console.error(`Cartella non valida: ${chosenDir}`);
      if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
      await pool.end();
      process.exit(1);
    }
  } else {
    const baseDir  = path.resolve(__dirname, "../backups");
    const backups  = listBackups(baseDir, envTarget, includeAll);
    if (backups.length === 0) {
      console.error(`Nessun backup ${includeAll ? "" : `'${envTarget}' `}trovato in ${baseDir}`);
      console.error(`Suggerimento: esegui 'npm run db:backup' oppure '--all' per tutti gli env.`);
      if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
      await pool.end();
      process.exit(1);
    }

    console.log(`\nBackup disponibili (${backups.length}) — env: ${includeAll ? "tutti" : envTarget}:\n`);
    backups.forEach((b, i) => {
      const tables = b.tables
        ? Object.values(b.tables).filter(v => typeof v === "number").reduce((a, n) => a + n, 0)
        : "?";
      console.log(`  [${String(i + 1).padStart(2, " ")}] ${b.name}  ` +
                  `(${b.env}, ${fmtBytes(b.size)}, ~${tables} righe)`);
    });
    console.log();

    const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
    const sel = await ask(rl, `Seleziona numero backup (1-${backups.length}) o 'q' per uscire: `);
    if (sel.toLowerCase() === "q" || sel === "") {
      console.log("Annullato.");
      rl.close();
      if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
      await pool.end();
      return;
    }
    const idx = parseInt(sel, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= backups.length) {
      console.error("Selezione non valida.");
      rl.close();
      if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
      await pool.end();
      process.exit(1);
    }
    chosenDir = backups[idx].full;

    if (!skipConfirm) {
      const envLabel = isProd ? "⚠ PROD (PRODUZIONE!)" : "DEV";
      console.log(`\n⚠ ATTENZIONE: tutte le tabelle del DB ${envLabel} verranno SVUOTATE e ripopolate da:`);
      console.log(`  ${chosenDir}\n`);
      const conf = await ask(rl, `Confermi il ripristino? digita 'SI' per procedere: `);
      if (conf !== "SI") {
        console.log("Annullato.");
        rl.close();
        if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
        await pool.end();
        return;
      }
    }
    rl.close();
  }

  log(`Restore da: ${chosenDir} → DB ${envTarget.toUpperCase()}`);
  try {
    await restoreFromDir(pool, chosenDir);
    console.log(`\n${"═".repeat(50)}`);
    console.log(`  Ripristino ${envTarget.toUpperCase()} completato`);
    console.log("═".repeat(50));
    console.log(`  📁 ${chosenDir}\n`);
  } catch (err) {
    console.error("\nERRORE durante il ripristino (rollback eseguito):", err.message);
    process.exit(1);
  } finally {
    await pool.end();
    if (tunnel) { tunnel.server.close(); tunnel.conn.end(); }
  }
}

main();
