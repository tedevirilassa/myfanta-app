"use strict";
/**
 * Fase 2: corregge l'offset di timezone applicato da to_timestamp (fase 1)
 * e normalizza tutti i valori a mezzogiorno UTC (12:00:00) dello stesso giorno.
 *
 * Logica: to_timestamp('MM-YYYY') ha applicato l'offset Rome (UTC+1/+2),
 * per cui '01-2026' è diventato 2025-12-31 23:00:00 UTC invece di
 * 2026-01-01 12:00:00 UTC. Aggiungendo 2h e troncando al giorno si recupera
 * la data corretta; poi si porta a mezzogiorno per sicurezza in tutti i fusi.
 */
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("Prima della correzione:");
    const { rows: before } = await client.query(`
      SELECT "dataStipula", "dataFine" FROM contratti WHERE "dataStipula" IS NOT NULL LIMIT 3
    `);
    console.log(before);

    // Aggiunge 2h (offset massimo Italia CEST) e tronca al giorno, poi porta a 12:00:00
    await client.query(`
      UPDATE contratti
        SET "dataStipula" = date_trunc('day', "dataStipula" + INTERVAL '2 hours') + INTERVAL '12 hours'
      WHERE "dataStipula" IS NOT NULL
    `);
    await client.query(`
      UPDATE contratti
        SET "dataFine" = date_trunc('day', "dataFine" + INTERVAL '2 hours') + INTERVAL '12 hours'
      WHERE "dataFine" IS NOT NULL
    `);
    // dataDecorrenza: tutti NULL, la conversione tipo è già corretta
    await client.query(`
      UPDATE trattative_mercato
        SET "dataDecorrenza" = date_trunc('day', "dataDecorrenza" + INTERVAL '2 hours') + INTERVAL '12 hours'
      WHERE "dataDecorrenza" IS NOT NULL
    `);

    await client.query("COMMIT");

    console.log("\nDopo la correzione:");
    const { rows: after } = await client.query(`
      SELECT "dataStipula", "dataFine" FROM contratti WHERE "dataStipula" IS NOT NULL LIMIT 3
    `);
    console.log(after);
    console.log("\nCorrezione timezone completata.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERRORE – ROLLBACK:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
