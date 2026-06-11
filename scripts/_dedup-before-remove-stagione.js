"use strict";
/**
 * Deduplica le tabelle prima di rimuovere la colonna 'stagione':
 * - situazione_finanziaria: mantieni la riga più recente per fantaTeamId
 * - rosa_giocatori:         mantieni la riga più recente per (fantaTeamId, giocatoreId)
 * - proposte_rinnovo:       mantieni tutte (già unique per contratto, niente duplicati)
 * - movimenti_finanziari:   nessuna deduplica (log continuo)
 * - quotazioni:             nessuna deduplica (storico prezzi)
 *
 * Uso: node scripts/_dedup-before-remove-stagione.js [--prod]
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

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── situazione_finanziaria: tieni la riga con stagione più alta per team ──
    const { rows: sfRows } = await client.query(`
      SELECT id, "fantaTeamId", "nomePresidente", stagione, "updatedAt"
      FROM situazione_finanziaria
      ORDER BY "fantaTeamId", stagione DESC
    `);
    // Raggruppa per fantaTeamId, tieni il primo (stagione più recente)
    const sfKeep = new Map();
    for (const r of sfRows) {
      if (!sfKeep.has(r.fantaTeamId)) sfKeep.set(r.fantaTeamId, r.id);
    }
    // Tieni anche quelli senza fantaTeamId (per nomePresidente)
    const sfByNome = new Map();
    for (const r of sfRows) {
      if (r.fantaTeamId == null) {
        if (!sfByNome.has(r.nomePresidente)) sfByNome.set(r.nomePresidente, r.id);
      }
    }
    const idsToKeep = new Set([...sfKeep.values(), ...sfByNome.values()]);
    const sfDelResult = await client.query(`
      DELETE FROM situazione_finanziaria WHERE id NOT IN (${[...idsToKeep].join(",") || 0})
    `);
    console.log(`situazione_finanziaria: eliminate ${sfDelResult.rowCount} righe duplicate`);

    // ── rosa_giocatori: tieni la riga più recente per (fantaTeamId, giocatoreId) ──
    const { rows: rosaRows } = await client.query(`
      SELECT id, "fantaTeamId", "giocatoreId", stagione
      FROM rosa_giocatori
      ORDER BY "fantaTeamId", "giocatoreId", stagione DESC
    `);
    const rosaKeep = new Map();
    for (const r of rosaRows) {
      const k = `${r.fantaTeamId}:${r.giocatoreId}`;
      if (!rosaKeep.has(k)) rosaKeep.set(k, r.id);
    }
    const rosaIds = [...rosaKeep.values()];
    const rosaDelResult = await client.query(`
      DELETE FROM rosa_giocatori WHERE id NOT IN (${rosaIds.join(",") || 0})
    `);
    console.log(`rosa_giocatori: eliminate ${rosaDelResult.rowCount} righe duplicate`);

    await client.query("COMMIT");
    console.log("Deduplicazione completata.");
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
