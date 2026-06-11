/**
 * scripts/_backup-full.js
 * Crea un backup completo: codice sorgente + dump JSON del DB in un unico .zip
 * con la data odierna nella cartella backups/.
 *
 * Uso: node scripts/_backup-full.js
 */
"use strict";

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { ZipArchive } = require("archiver");

const ROOT = path.resolve(__dirname, "..");

// Cartelle/file da includere nel backup del codice
const CODE_INCLUDES = ["src", "prisma", "public", "scripts"];
const CODE_FILES    = ["package.json", "package-lock.json", "nodemon.json",
                       "prisma.config.ts", "project.md", "comandi.txt"];

// Tabelle DB da esportare
const TABLES = [
  "fanta_teams", "giocatori", "contratti",
  "situazione_finanziaria", "rosa_giocatori",
  "proposte_rinnovo", "trattative_mercato",
  "movimenti_finanziari", "log_azioni", "parametri",
];

// Nome zip con data odierna
const now      = new Date();
const pad      = (n) => String(n).padStart(2, "0");
const dateName = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
const zipName  = `backup-${dateName}.zip`;
const zipPath  = path.join(ROOT, "backups", zipName);

async function dumpDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dump = {};
  for (const table of TABLES) {
    try {
      const { rows } = await pool.query(`SELECT * FROM "${table}" ORDER BY id`);
      dump[table] = rows;
      console.log(`  [db] ${table}: ${rows.length} righe`);
    } catch (e) {
      console.log(`  [db] ${table}: SKIP (${e.message.split("\n")[0]})`);
      dump[table] = [];
    }
  }
  await pool.end();
  return dump;
}

async function main() {
  console.log(`Backup completo → ${zipPath}\n`);

  // Dump DB
  console.log("Esportazione DB...");
  const dump = await dumpDb();
  const dbJson = JSON.stringify(dump, null, 2);

  // Crea zip
  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);

    // Codice sorgente
    for (const dir of CODE_INCLUDES) {
      const dirPath = path.join(ROOT, dir);
      if (fs.existsSync(dirPath)) {
        archive.directory(dirPath, dir);
      }
    }
    for (const file of CODE_FILES) {
      const filePath = path.join(ROOT, file);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file });
      }
    }

    // Dump DB come JSON
    archive.append(dbJson, { name: "db-dump.json" });

    archive.finalize();
  });

  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
  console.log(`\n✓ Backup completato: ${zipName} (${sizeKb} KB)`);
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
