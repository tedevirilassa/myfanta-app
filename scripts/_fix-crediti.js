"use strict";
require("dotenv").config();
const { Pool } = require("pg");

const CREDITI = [
  { nome: "Danilo",    crediti: 211.83 },
  { nome: "Giulio",   crediti: 206.22 },
  { nome: "Marco",    crediti: 106.30 },
  { nome: "Lorenzo",  crediti: 88.11  },
  { nome: "Gabriele", crediti: 217.21 },
  { nome: "Andrea",   crediti: 342.36 },
  { nome: "Paolo",    crediti: 68.48  },
  { nome: "Luca",     crediti: 213.43 },
  { nome: "Angelo",   crediti: 228.73 },
  { nome: "Valentino",crediti: 70.43  },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Prima mostra tutti i presidenti
  const { rows } = await pool.query('SELECT id, "nomePresidente", crediti FROM situazione_finanziaria ORDER BY "nomePresidente"');
  console.log("Presidenti nel DB:");
  rows.forEach(r => console.log(`  ${r.id}  ${r.nomePresidente}  →  ${r.crediti}`));

  // Aggiorna i crediti
  console.log("\nAggiornamento crediti...");
  for (const entry of CREDITI) {
    const res = await pool.query(
      `UPDATE situazione_finanziaria SET crediti = $1, patrimonio = (
        SELECT COALESCE((
          SELECT SUM(g.valore)
          FROM contratti c
          JOIN giocatori g ON g.id = c."giocatoreId"
          WHERE c."fantaTeamId" = sf."fantaTeamId" AND c.valido = true AND c.tipo = 'Acquisto'
        ), 0)
        FROM situazione_finanziaria sf
        WHERE sf."nomePresidente" ILIKE $2
      ) + $1
      WHERE "nomePresidente" ILIKE $2
      RETURNING id, "nomePresidente", crediti, patrimonio`,
      [entry.crediti, `%${entry.nome}%`]
    );
    if (res.rowCount === 0) {
      console.log(`  ⚠ Non trovato: ${entry.nome}`);
    } else {
      const r = res.rows[0];
      console.log(`  ✓ ${r.nomePresidente}: crediti=${r.crediti}, patrimonio=${r.patrimonio}`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
