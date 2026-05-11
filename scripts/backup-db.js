/**
 * scripts/backup-db.js
 *
 * Esporta tutte le tabelle del database in file JSON nella cartella backups/.
 * Ogni backup crea una sotto-cartella con timestamp.
 *
 * Uso:
 *   node scripts/backup-db.js                → backup dal DB locale (.env)
 *   node scripts/backup-db.js --remote       → backup dal DB remoto (.envpublic)
 *   node scripts/backup-db.js --out <dir>    → cartella di output personalizzata
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// ─── Parsing env file ────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File non trovato: ${abs}`);
  }
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[backup] ${msg}`);
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
    query: `SELECT id, "giocatoreId", valore, fonte, stagione, "createdAt"
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
    query: `SELECT id, "nomePresidente", stagione, "valoreRose", crediti,
                   patrimonio, "giocatoriTesserati", "etaMedia", stipendi,
                   "montePrestiti", "ultimoPlusMinus", "fantaTeamId",
                   "createdAt", "updatedAt"
            FROM situazione_finanziaria ORDER BY id`,
  },
  {
    name: "rosa_giocatori",
    query: `SELECT id, "fantaTeamId", "giocatoreId", stagione, categoria,
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
  const args = process.argv.slice(2);
  const isRemote = args.includes("--remote");

  // Cartella di output
  const outIdx = args.indexOf("--out");
  const baseDir = outIdx !== -1 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : path.resolve(__dirname, "../backups");

  // Timestamp per sotto-cartella
  const now = new Date();
  const ts = now.toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
  const source = isRemote ? "render" : "locale";
  const backupDir = path.join(baseDir, `${ts}_${source}`);

  // Connessione
  const envFile = isRemote ? "../.envpublic" : "../.env";
  const env = parseEnvFile(path.join(__dirname, envFile));
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) throw new Error(`DATABASE_URL mancante in ${envFile}`);

  const poolOpts = { connectionString: dbUrl };
  if (isRemote) poolOpts.ssl = { rejectUnauthorized: false };
  const pool = new Pool(poolOpts);

  try {
    await pool.query("SELECT 1");
    log(`Connesso al DB ${source}`);
  } catch (e) {
    console.error(`Impossibile connettersi al DB ${source}:`, e.message);
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
        // La tabella potrebbe non esistere (es. quotazioni pre-migrazione)
        log(`  ⚠ Errore su ${table.name}: ${err.message}`);
        summary[table.name] = "ERRORE";
      }
    }

    // Scrivi riepilogo
    const summaryPath = path.join(backupDir, "_summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify({
      timestamp: now.toISOString(),
      source,
      tables: summary,
    }, null, 2), "utf8");

    console.log(`\n${"═".repeat(50)}`);
    console.log("  Backup completato");
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
  }
}

main();
