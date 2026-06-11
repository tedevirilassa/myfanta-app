"use strict";
/**
 * Migra le colonne date da TEXT a TIMESTAMP(3) sul DB di produzione.
 * Fase 1: ALTER COLUMN ... TYPE TIMESTAMP USING to_timestamp(value, 'MM-YYYY')
 * Fase 2: corregge offset timezone (+2h) e normalizza a mezzogiorno UTC.
 *
 * Uso: node scripts/_migrate-dates-prod.js [--prod]
 *   --prod  usa DATABASE_URL_PROD (fantaserver)
 */
require("dotenv").config();
const { Pool } = require("pg");
const dns = require("dns");

const isProd = process.argv.includes("--prod");
if (isProd) dns.setDefaultResultOrder("ipv4first");

const connStr = isProd ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL;
if (!connStr) { console.error("CONNECTION STRING mancante"); process.exit(1); }

console.log(`Connessione a: ${isProd ? "PROD" : "LOCAL"}`);
const pool = new Pool({ connectionString: connStr });

async function columnType(client, table, column) {
  const { rows } = await client.query(`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
  `, [table, column]);
  return rows[0]?.data_type || null;
}

async function main() {
  const client = await pool.connect();
  try {
    // ── FASE 1: conversione TEXT → TIMESTAMP ──────────────────────────────────
    const stipulaType = await columnType(client, "contratti", "dataStipula");
    console.log(`contratti.dataStipula tipo attuale: ${stipulaType}`);

    if (stipulaType && (stipulaType.toLowerCase().includes("char") || stipulaType === "text")) {
      console.log("\n── Fase 1: conversione TEXT → TIMESTAMP ────────────────");

      await client.query("BEGIN");
      // Aggiunge colonne temporanee per la conversione sicura
      await client.query(`
        ALTER TABLE contratti
          ADD COLUMN IF NOT EXISTS "dataStipula_ts" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "dataFine_ts"    TIMESTAMP(3)
      `);
      await client.query(`
        UPDATE contratti
        SET "dataStipula_ts" = to_timestamp("dataStipula", 'MM-YYYY')
        WHERE "dataStipula" IS NOT NULL AND "dataStipula" ~ '^\\d{2}-\\d{4}$'
      `);
      await client.query(`
        UPDATE contratti
        SET "dataFine_ts" = to_timestamp("dataFine", 'MM-YYYY')
        WHERE "dataFine" IS NOT NULL AND "dataFine" ~ '^\\d{2}-\\d{4}$'
      `);
      // Drop le colonne originali e rinomina le temporanee
      await client.query(`ALTER TABLE contratti DROP COLUMN "dataStipula"`);
      await client.query(`ALTER TABLE contratti RENAME COLUMN "dataStipula_ts" TO "dataStipula"`);
      await client.query(`ALTER TABLE contratti DROP COLUMN "dataFine"`);
      await client.query(`ALTER TABLE contratti RENAME COLUMN "dataFine_ts" TO "dataFine"`);
      await client.query("COMMIT");
      console.log("contratti: dataStipula, dataFine convertiti.");

      // dataDecorrenza su trattative_mercato
      await client.query("BEGIN");
      const decType = await columnType(client, "trattative_mercato", "dataDecorrenza");
      if (decType && (decType.toLowerCase().includes("char") || decType === "text")) {
        await client.query(`
          ALTER TABLE trattative_mercato
            ADD COLUMN IF NOT EXISTS "dataDecorrenza_ts" TIMESTAMP(3)
        `);
        await client.query(`
          UPDATE trattative_mercato
          SET "dataDecorrenza_ts" = to_timestamp("dataDecorrenza", 'MM-YYYY')
          WHERE "dataDecorrenza" IS NOT NULL AND "dataDecorrenza" ~ '^\\d{2}-\\d{4}$'
        `);
        await client.query(`ALTER TABLE trattative_mercato DROP COLUMN "dataDecorrenza"`);
        await client.query(`ALTER TABLE trattative_mercato RENAME COLUMN "dataDecorrenza_ts" TO "dataDecorrenza"`);
        console.log("trattative_mercato: dataDecorrenza convertita.");
      } else {
        console.log("trattative_mercato.dataDecorrenza già convertita, skip.");
      }

      // dataNascita su giocatori (TEXT → TIMESTAMP se necessario)
      const nascitaType = await columnType(client, "giocatori", "dataNascita");
      if (nascitaType && (nascitaType.toLowerCase().includes("char") || nascitaType === "text")) {
        await client.query(`
          ALTER TABLE giocatori
            ADD COLUMN IF NOT EXISTS "dataNascita_ts" TIMESTAMP(3)
        `);
        // dataNascita potrebbe essere DD-MM-YYYY o MM-YYYY - prova DD-MM-YYYY prima
        await client.query(`
          UPDATE giocatori
          SET "dataNascita_ts" = to_timestamp("dataNascita", 'DD-MM-YYYY')
          WHERE "dataNascita" IS NOT NULL AND "dataNascita" ~ '^\\d{2}-\\d{2}-\\d{4}$'
        `);
        await client.query(`
          UPDATE giocatori
          SET "dataNascita_ts" = to_timestamp("dataNascita", 'MM-YYYY')
          WHERE "dataNascita" IS NOT NULL AND "dataNascita" ~ '^\\d{2}-\\d{4}$'
            AND "dataNascita_ts" IS NULL
        `);
        await client.query(`ALTER TABLE giocatori DROP COLUMN "dataNascita"`);
        await client.query(`ALTER TABLE giocatori RENAME COLUMN "dataNascita_ts" TO "dataNascita"`);
        console.log("giocatori: dataNascita convertita.");
      } else {
        console.log("giocatori.dataNascita già convertita, skip.");
      }
      await client.query("COMMIT");
    } else {
      console.log("Colonne già TIMESTAMP, fase 1 saltata.");
    }

    // ── FASE 2: correzione timezone ───────────────────────────────────────────
    console.log("\n── Fase 2: correzione offset timezone (+2h → mezzogiorno UTC) ──");
    await client.query("BEGIN");
    await client.query(`
      UPDATE contratti
        SET "dataStipula" = date_trunc('day', "dataStipula" + INTERVAL '2 hours') + INTERVAL '12 hours'
      WHERE "dataStipula" IS NOT NULL
        AND EXTRACT(HOUR FROM "dataStipula") != 12
    `);
    await client.query(`
      UPDATE contratti
        SET "dataFine" = date_trunc('day', "dataFine" + INTERVAL '2 hours') + INTERVAL '12 hours'
      WHERE "dataFine" IS NOT NULL
        AND EXTRACT(HOUR FROM "dataFine") != 12
    `);
    await client.query(`
      UPDATE trattative_mercato
        SET "dataDecorrenza" = date_trunc('day', "dataDecorrenza" + INTERVAL '2 hours') + INTERVAL '12 hours'
      WHERE "dataDecorrenza" IS NOT NULL
        AND EXTRACT(HOUR FROM "dataDecorrenza") != 12
    `);
    await client.query("COMMIT");
    console.log("Correzione timezone completata.");

    // ── Verifica ──────────────────────────────────────────────────────────────
    const { rows: sample } = await client.query(`
      SELECT "dataStipula", "dataFine" FROM contratti WHERE "dataStipula" IS NOT NULL LIMIT 3
    `);
    console.log("\nSample contratti:", sample);

    console.log("\nMigrazione date completata con successo.");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("ERRORE – ROLLBACK:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
