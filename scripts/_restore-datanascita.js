"use strict";
/**
 * Ripristina il campo dataNascita dei giocatori dal backup JSON.
 * Usato dopo che db push ha droppato la colonna durante la migrazione a DateTime.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const BACKUP_FILE = path.join(__dirname, "../backups/2026-06-04-15-05-49_locale/giocatori.json");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const giocatori = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));

  const withDate = giocatori.filter(g => g.dataNascita);
  console.log(`Trovati ${withDate.length} giocatori con dataNascita nel backup`);

  let ok = 0, skip = 0;
  for (const g of withDate) {
    // Formato atteso: YYYY-MM-DD → compatibile con DateTime PostgreSQL
    const parsed = new Date(g.dataNascita);
    if (isNaN(parsed.getTime())) {
      console.warn(`  SKIP id=${g.id} dataNascita="${g.dataNascita}" (non parsabile)`);
      skip++;
      continue;
    }
    await pool.query(
      `UPDATE giocatori SET "dataNascita" = $1 WHERE id = $2`,
      [parsed.toISOString(), g.id]
    );
    ok++;
  }

  console.log(`Ripristinati: ${ok}, Saltati: ${skip}`);
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
