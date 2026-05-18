/**
 * scripts/restore-db.js
 *
 * Ripristina il DB locale da una cartella di backup prodotta da scripts/backup-db.js.
 * Mostra l'elenco dei backup disponibili, fa scegliere quale, chiede conferma,
 * poi TRUNCATE + INSERT in ordine FK e reset delle sequence.
 *
 * Uso:
 *   node scripts/restore-db.js                    → menu interattivo, solo backup "locale"
 *   node scripts/restore-db.js --all              → include anche backup "render"
 *   node scripts/restore-db.js --dir <path>       → restore non-interattivo da cartella specifica
 *   node scripts/restore-db.js --yes              → skip conferma finale (USARE CON CAUTELA)
 *
 * Nota: l'operazione è DISTRUTTIVA. Tutte le tabelle elencate in TABLES_ORDER
 *       vengono svuotate (TRUNCATE ... RESTART IDENTITY CASCADE) e ripopolate
 *       dai file JSON.
 */

"use strict";

const fs       = require("fs");
const path     = require("path");
const readline = require("readline");
const { Pool } = require("pg");

// ─── env loader ──────────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File non trovato: ${abs}`);
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
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

function listBackups(baseDir, includeAll) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir)
    .map(name => ({ name, full: path.join(baseDir, name) }))
    .filter(e => fs.statSync(e.full).isDirectory());

  const items = [];
  for (const e of entries) {
    const summary = readSummary(e.full);
    const source = summary?.source || (e.name.includes("render") ? "render" : "locale");
    if (!includeAll && source !== "locale") continue;
    items.push({
      name:      e.name,
      full:      e.full,
      timestamp: summary?.timestamp || null,
      source,
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
  const args = process.argv.slice(2);
  const includeAll = args.includes("--all");
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  const dirIdx = args.indexOf("--dir");
  const explicitDir = dirIdx !== -1 ? args[dirIdx + 1] : null;

  // Connessione DB locale
  const env = parseEnvFile(path.join(__dirname, "../.env"));
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL mancante in .env");
  const pool = new Pool({ connectionString: dbUrl });

  try {
    await pool.query("SELECT 1");
    log("Connesso al DB locale");
  } catch (e) {
    console.error("Impossibile connettersi al DB locale:", e.message);
    process.exit(1);
  }

  let chosenDir;

  if (explicitDir) {
    chosenDir = path.resolve(explicitDir);
    if (!fs.existsSync(chosenDir) || !fs.statSync(chosenDir).isDirectory()) {
      console.error(`Cartella non valida: ${chosenDir}`);
      process.exit(1);
    }
  } else {
    const baseDir = path.resolve(__dirname, "../backups");
    const backups = listBackups(baseDir, includeAll);
    if (backups.length === 0) {
      console.error(`Nessun backup ${includeAll ? "" : "locale "}trovato in ${baseDir}`);
      console.error(`Suggerimento: esegui prima 'npm run db:backup' oppure usa --all per includere backup remoti.`);
      await pool.end();
      process.exit(1);
    }

    console.log(`\nBackup disponibili (${backups.length}):\n`);
    backups.forEach((b, i) => {
      const tables = b.tables
        ? Object.values(b.tables).filter(v => typeof v === "number").reduce((a, n) => a + n, 0)
        : "?";
      console.log(`  [${String(i + 1).padStart(2, " ")}] ${b.name}  ` +
                  `(${b.source}, ${fmtBytes(b.size)}, ~${tables} righe)`);
    });
    console.log();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const sel = await ask(rl, `Seleziona numero backup (1-${backups.length}) o 'q' per uscire: `);
    if (sel.toLowerCase() === "q" || sel === "") {
      console.log("Annullato.");
      rl.close();
      await pool.end();
      return;
    }
    const idx = parseInt(sel, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= backups.length) {
      console.error("Selezione non valida.");
      rl.close();
      await pool.end();
      process.exit(1);
    }
    chosenDir = backups[idx].full;

    if (!skipConfirm) {
      console.log(`\n⚠ ATTENZIONE: tutte le tabelle del DB locale verranno SVUOTATE e ripopolate da:`);
      console.log(`  ${chosenDir}\n`);
      const conf = await ask(rl, `Confermi il ripristino? digita 'SI' per procedere: `);
      if (conf !== "SI") {
        console.log("Annullato.");
        rl.close();
        await pool.end();
        return;
      }
    }
    rl.close();
  }

  log(`Restore da: ${chosenDir}`);
  try {
    await restoreFromDir(pool, chosenDir);
    console.log(`\n${"═".repeat(50)}`);
    console.log("  Ripristino completato");
    console.log("═".repeat(50));
    console.log(`  📁 ${chosenDir}\n`);
  } catch (err) {
    console.error("\nERRORE durante il ripristino (rollback eseguito):", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
