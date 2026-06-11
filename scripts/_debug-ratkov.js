"use strict";
require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function main() {
  // Trova Ratkov
  const { rows: giocatori } = await pool.query(
    "SELECT id, nome, ruolo FROM giocatori WHERE nome ILIKE $1", ["%ratkov%"]
  );
  console.log("Giocatori trovati:", JSON.stringify(giocatori));
  if (!giocatori.length) { await pool.end(); return; }
  const gId = giocatori[0].id;

  // Trova trattative per Ratkov
  const { rows: tratt } = await pool.query(`
    SELECT t.id, t.stato, t."importoOfferta", t."dataDecorrenza",
           t."anniContrattoProposti", t."categoriaProposta",
           tm.nome AS mittente, tr.nome AS ricevente,
           t."fantaTeamMittenteId", t."fantaTeamRiceventeId"
    FROM trattative_mercato t
    JOIN fanta_teams tm ON tm.id = t."fantaTeamMittenteId"
    JOIN fanta_teams tr ON tr.id = t."fantaTeamRiceventeId"
    WHERE t."giocatoreId" = $1
    ORDER BY t.id DESC
  `, [gId]);
  console.log("Trattative:", JSON.stringify(tratt, null, 2));

  // Trova Como Supersonics
  const { rows: como } = await pool.query(`
    SELECT ft.id, ft.nome, fp.email, fp.nickname, fp.id AS "userId"
    FROM fanta_teams ft
    JOIN fantapresidenti fp ON fp.id = ft."userId"
    WHERE ft.nome ILIKE $1
  `, ["%como%"]);
  console.log("Como Supersonics:", JSON.stringify(como));

  // Situazione finanziaria dei team coinvolti
  if (tratt.length > 0) {
    const t = tratt[0];
    const teamIds = [t.fantaTeamMittenteId, t.fantaTeamRiceventeId];
    const { rows: sf } = await pool.query(`
      SELECT sf.id, sf."fantaTeamId", ft.nome, sf.crediti, sf.patrimonio, sf.stipendi
      FROM situazione_finanziaria sf
      JOIN fanta_teams ft ON ft.id = sf."fantaTeamId"
      WHERE sf."fantaTeamId" = ANY($1)
      ORDER BY sf."updatedAt" DESC
    `, [teamIds]);
    console.log("Situazione finanziaria:", JSON.stringify(sf, null, 2));
  }

  await pool.end();
}
main().catch(e => { console.error("ERRORE:", e.message); process.exit(1); });
