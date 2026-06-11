/**
 * scripts/sync-to-prod.js
 *
 * Allinea il database locale (DEV) con quello di PROD su fantaserver
 * aprendo un tunnel SSH via ssh2 (autenticazione con password).
 *
 * Cosa fa:
 *   1. Apre un tunnel SSH  localhost:5454  →  localhost:5432  (sul server remoto)
 *   2. (opzionale) Applica le migration Prisma al DB PROD tramite il tunnel
 *   3. Copia tutti i dati dal DB locale al DB PROD tabella per tabella
 *   4. Riallinea le sequenze degli ID
 *   5. Chiude il tunnel
 *
 * Variabili .env:
 *   DATABASE_URL_PROD     connessione PostgreSQL PROD
 *   PROD_SSH_HOST         (default: hostname da DATABASE_URL_PROD)
 *   PROD_SSH_PORT         (default: 22)
 *   PROD_SSH_USER         (default: "fantauser")
 *   PROD_SSH_PASSWORD     password SSH
 *   PROD_DB_REMOTE_HOST   host PostgreSQL sul server remoto (default: localhost)
 *
 * Uso:
 *   node scripts/sync-to-prod.js              → solo dati
 *   node scripts/sync-to-prod.js --migrate    → migrate + dati
 *   node scripts/sync-to-prod.js --migrate-only → solo migrate
 */

"use strict";

require("dotenv").config();

const fs      = require("fs");
const path    = require("path");
const net     = require("net");
const { execSync } = require("child_process");
const { Client }   = require("ssh2");
const { Pool }     = require("pg");

const TUNNEL_LOCAL_PORT = 5454;

// ─── Config ──────────────────────────────────────────────────────────────────

const DATABASE_URL_PROD = process.env.DATABASE_URL_PROD;
const DATABASE_URL      = process.env.DATABASE_URL;

if (!DATABASE_URL_PROD) { console.error("DATABASE_URL_PROD mancante in .env"); process.exit(1); }
if (!DATABASE_URL)      { console.error("DATABASE_URL mancante in .env");       process.exit(1); }

// Estrae hostname dalla URL PROD per usarlo come SSH host di default
function extractHost(connStr) {
  try { return new URL(connStr).hostname; } catch { return null; }
}

const SSH_HOST       = process.env.PROD_SSH_HOST     || extractHost(DATABASE_URL_PROD) || "fantaserver";
const SSH_PORT       = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER       = process.env.PROD_SSH_USER     || "fantauser";
const SSH_PASS       = process.env.PROD_SSH_PASSWORD;
const REMOTE_DB_HOST = process.env.PROD_DB_REMOTE_HOST || "localhost";
const REMOTE_DB_PORT = 5432;

if (!SSH_PASS) { console.error("PROD_SSH_PASSWORD mancante in .env"); process.exit(1); }

const DO_MIGRATE      = process.argv.includes("--migrate") || process.argv.includes("--migrate-only");
const MIGRATE_ONLY    = process.argv.includes("--migrate-only");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg)     { console.log(`[sync-prod] ${msg}`); }
function section(t)   { console.log(`\n${"=".repeat(60)}\n  ${t}\n${"=".repeat(60)}`); }

// Costruisce la URL locale (attraverso il tunnel) per il DB prod
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

// ─── Tunnel SSH via ssh2 ──────────────────────────────────────────────────────

function startTunnel() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const server = net.createServer((socket) => {
      conn.forwardOut(
        "127.0.0.1", 0,
        REMOTE_DB_HOST, REMOTE_DB_PORT,
        (err, channel) => {
          if (err) { socket.destroy(); return; }
          socket.pipe(channel).pipe(socket);
          socket.on("error",  () => channel.destroy());
          channel.on("error", () => socket.destroy());
          channel.on("close", () => socket.destroy());
          socket.on("close",  () => channel.destroy());
        }
      );
    });

    server.on("error", (err) => reject(new Error(`Server locale: ${err.message}`)));

    conn.on("ready", () => {
      // Avvia il TCP server solo DOPO che SSH è pronto
      server.listen(TUNNEL_LOCAL_PORT, "127.0.0.1", () => {
        log(`Tunnel SSH attivo: localhost:${TUNNEL_LOCAL_PORT} -> ${REMOTE_DB_HOST}:${REMOTE_DB_PORT}`);
        resolve({ conn, server });
      });
    });

    conn.on("error", (err) => {
      server.close();
      reject(new Error(`SSH: ${err.message}`));
    });

    conn.connect({
      host: SSH_HOST, port: SSH_PORT,
      username: SSH_USER, password: SSH_PASS,
      readyTimeout: 20000,
    });
  });
}

// ─── Prisma migrate deploy ────────────────────────────────────────────────────

function runMigrate(tunnelUrl) {
  section("Prisma migrate deploy su PROD");
  const env = { ...process.env, DATABASE_URL: tunnelUrl };
  try {
    execSync("npx prisma migrate deploy", {
      env,
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
    log("Migration applicate.");
  } catch (e) {
    throw new Error("Migrate fallita: " + e.message);
  }
}

// ─── Sync tabelle ─────────────────────────────────────────────────────────────

const TABLES = [
  "fanta_teams",
  "giocatori",
  "quotazioni",
  "contratti",
  "situazione_finanziaria",
  "rosa_giocatori",
  "proposte_rinnovo",
  "trattative_mercato",
  "movimenti_finanziari",
  "log_azioni",
  "parametri",
];

// Tabelle con ordine di dipendenza per il TRUNCATE
const TRUNCATE_ORDER = [...TABLES].reverse();

async function syncTables(localPool, prodPool) {
  section("Sync tabelle");

  // 1. Svuota le tabelle PROD (in ordine inverso per le FK)
  log("TRUNCATE tabelle PROD (CASCADE)...");
  const truncateClient = await prodPool.connect();
  try {
    await truncateClient.query("BEGIN");
    for (const table of TRUNCATE_ORDER) {
      try {
        await truncateClient.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
        log(`  TRUNCATE ${table}`);
      } catch (e) {
        log(`  SKIP ${table}: ${e.message.split("\n")[0]}`);
      }
    }
    await truncateClient.query("COMMIT");
  } catch (e) {
    await truncateClient.query("ROLLBACK");
    throw e;
  } finally {
    truncateClient.release();
  }

  // 2. Copia ogni tabella
  for (const table of TABLES) {
    let rows;
    try {
      const res = await localPool.query(`SELECT * FROM "${table}" ORDER BY id`);
      rows = res.rows;
    } catch (e) {
      log(`  SKIP ${table} (non esiste in locale): ${e.message.split("\n")[0]}`);
      continue;
    }

    if (rows.length === 0) {
      log(`  ${table}: vuota, skip`);
      continue;
    }

    const cols  = Object.keys(rows[0]);
    const colsSql = cols.map((c) => `"${c}"`).join(", ");

    const prodClient = await prodPool.connect();
    try {
      await prodClient.query("BEGIN");
      for (const row of rows) {
        const vals  = cols.map((c) => row[c]);
        const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
        await prodClient.query(
          `INSERT INTO "${table}" (${colsSql}) VALUES (${placeholders})`,
          vals
        );
      }
      // Riallinea la sequenza
      await prodClient.query(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
      );
      await prodClient.query("COMMIT");
      log(`  ${table}: ${rows.length} righe`);
    } catch (e) {
      await prodClient.query("ROLLBACK");
      log(`  ${table}: ERRORE — ${e.message.split("\n")[0]}`);
    } finally {
      prodClient.release();
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  section("Sync DEV -> PROD (fantaserver)");
  console.log(`  SSH:  ${SSH_USER}@${SSH_HOST}:${SSH_PORT}`);
  console.log(`  DB:   ${REMOTE_DB_HOST}:${REMOTE_DB_PORT} (via tunnel)`);
  console.log(`  Migrate: ${DO_MIGRATE ? "sì" : "no"}\n`);

  let tunnel = null;
  let localPool = null;
  let prodPool  = null;

  try {
    tunnel = await startTunnel();
    const tunnelUrl = buildTunnelUrl(DATABASE_URL_PROD);

    if (DO_MIGRATE) {
      runMigrate(tunnelUrl);
    }

    if (!MIGRATE_ONLY) {
      localPool = new Pool({ connectionString: DATABASE_URL });
      prodPool  = new Pool({ connectionString: tunnelUrl, ssl: false });
      await syncTables(localPool, prodPool);
    }

    log("\nSync completata.");
  } finally {
    if (localPool) await localPool.end().catch(() => {});
    if (prodPool)  await prodPool.end().catch(() => {});
    if (tunnel) {
      tunnel.server.close();
      tunnel.conn.end();
    }
  }
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
