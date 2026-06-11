"use strict";
// Dedup situazione_finanziaria e rosa_giocatori su prod (senza colonna stagione)
// Uso: node scripts/_dedup-prod.js [--prod]
require("dotenv").config();
const { Pool } = require("pg");
const dns = require("dns");

const isProd = process.argv.includes("--prod");
if (isProd) dns.setDefaultResultOrder("ipv4first");
const connStr = isProd ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL;
if (!connStr) { console.error("CONNECTION STRING mancante"); process.exit(1); }
console.log(`Connessione a: ${isProd ? "PROD" : "LOCAL"}`);
const pool = new Pool({ connectionString: connStr });

async function main() {
  const client = await pool.connect();
  try {
    // ── situazione_finanziaria ────────────────────────────────────────────────
    // Conta duplicati per fantaTeamId
    const { rows: sfDups } = await client.query(`
      SELECT "fantaTeamId", COUNT(*) as cnt
      FROM situazione_finanziaria
      WHERE "fantaTeamId" IS NOT NULL
      GROUP BY "fantaTeamId"
      HAVING COUNT(*) > 1
    `);
    console.log(`situazione_finanziaria: ${sfDups.length} fantaTeamId con duplicati`);

    if (sfDups.length > 0) {
      await client.query("BEGIN");
      // Per ogni fantaTeamId duplicato: tieni solo l'id MIN (il più vecchio / primo importato)
      // oppure MAX(updatedAt) — usiamo MAX(id) come proxy per "più recente"
      const { rowCount } = await client.query(`
        DELETE FROM situazione_finanziaria
        WHERE id NOT IN (
          SELECT MAX(id) FROM situazione_finanziaria
          WHERE "fantaTeamId" IS NOT NULL
          GROUP BY "fantaTeamId"
        )
        AND "fantaTeamId" IS NOT NULL
      `);
      console.log(`situazione_finanziaria: eliminate ${rowCount} righe duplicate`);
      await client.query("COMMIT");
    }

    // Conta duplicati per nomePresidente
    const { rows: sfNomeDups } = await client.query(`
      SELECT "nomePresidente", COUNT(*) as cnt
      FROM situazione_finanziaria
      GROUP BY "nomePresidente"
      HAVING COUNT(*) > 1
    `);
    console.log(`situazione_finanziaria: ${sfNomeDups.length} nomePresidente con duplicati`);

    if (sfNomeDups.length > 0) {
      await client.query("BEGIN");
      const { rowCount } = await client.query(`
        DELETE FROM situazione_finanziaria
        WHERE id NOT IN (
          SELECT MAX(id) FROM situazione_finanziaria
          GROUP BY "nomePresidente"
        )
      `);
      console.log(`situazione_finanziaria nomePresidente: eliminate ${rowCount} righe`);
      await client.query("COMMIT");
    }

    // ── rosa_giocatori ────────────────────────────────────────────────────────
    const { rows: rosaDups } = await client.query(`
      SELECT "fantaTeamId", "giocatoreId", COUNT(*) as cnt
      FROM rosa_giocatori
      GROUP BY "fantaTeamId", "giocatoreId"
      HAVING COUNT(*) > 1
    `);
    console.log(`rosa_giocatori: ${rosaDups.length} (fantaTeamId,giocatoreId) con duplicati`);

    if (rosaDups.length > 0) {
      await client.query("BEGIN");
      const { rowCount } = await client.query(`
        DELETE FROM rosa_giocatori
        WHERE id NOT IN (
          SELECT MAX(id) FROM rosa_giocatori
          GROUP BY "fantaTeamId", "giocatoreId"
        )
      `);
      console.log(`rosa_giocatori: eliminate ${rowCount} righe duplicate`);
      await client.query("COMMIT");
    }

    // ── proposte_rinnovo ──────────────────────────────────────────────────────
    const { rows: propDups } = await client.query(`
      SELECT "fantaTeamId", "ordinePriorita", COUNT(*) as cnt
      FROM proposte_rinnovo
      GROUP BY "fantaTeamId", "ordinePriorita"
      HAVING COUNT(*) > 1
    `);
    console.log(`proposte_rinnovo: ${propDups.length} (fantaTeamId,ordinePriorita) con duplicati`);

    if (propDups.length > 0) {
      await client.query("BEGIN");
      const { rowCount } = await client.query(`
        DELETE FROM proposte_rinnovo
        WHERE id NOT IN (
          SELECT MAX(id) FROM proposte_rinnovo
          GROUP BY "fantaTeamId", "ordinePriorita"
        )
      `);
      console.log(`proposte_rinnovo: eliminate ${rowCount} righe duplicate`);
      await client.query("COMMIT");
    }

    console.log("\nDeduplicazione completata.");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("ERRORE – ROLLBACK:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
