// prisma/seed-parametri.js
// Popola la tabella parametri con i valori di default del regolamento.
"use strict";
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { PrismaPg }     = require("@prisma/adapter-pg");
const { Pool }         = require("pg");

const DEFAULTS = [
  // ── Rosa ──
  { chiave: "rosa_min_giocatori",    valore: "25", descrizione: "Numero minimo di giocatori per rosa" },
  { chiave: "rosa_max_giocatori",    valore: "30", descrizione: "Numero massimo di giocatori per rosa" },
  { chiave: "rosa_min_portieri",     valore: "3",  descrizione: "Numero minimo di portieri per rosa" },
  { chiave: "rosa_min_difensori",    valore: "8",  descrizione: "Numero minimo di difensori per rosa" },
  { chiave: "rosa_min_centrocampisti", valore: "8", descrizione: "Numero minimo di centrocampisti per rosa" },
  { chiave: "rosa_min_attaccanti",   valore: "6",  descrizione: "Numero minimo di attaccanti per rosa" },
  { chiave: "rosa_max_fuorirosa",   valore: "5",  descrizione: "Numero massimo di giocatori fuori rosa" },
  { chiave: "rosa_max_under21",     valore: "2",  descrizione: "Numero massimo di giocatori Under 21" },

  // ── Prestiti ──
  { chiave: "prestiti_max_in",           valore: "3",    descrizione: "Numero massimo di giocatori ricevuti in prestito" },
  { chiave: "prestiti_max_out",          valore: "3",    descrizione: "Numero massimo di giocatori dati in prestito" },
  { chiave: "prestiti_spesa_max_totale", valore: "5.00", descrizione: "Spesa massima totale per prestiti in ingresso (M)" },

  // ── Contratti ──
  { chiave: "contratto_durata_min", valore: "1", descrizione: "Durata minima del contratto (anni)" },
  { chiave: "contratto_durata_max", valore: "3", descrizione: "Durata massima del contratto (anni)" },
  { chiave: "stipendio_percentuale", valore: "0.05", descrizione: "Percentuale del valore giocatore per calcolo stipendio" },

  // ── Budget ──
  { chiave: "budget_iniziale", valore: "100", descrizione: "Budget iniziale per presidente (M)" },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  let created = 0, skipped = 0;

  for (const p of DEFAULTS) {
    const existing = await prisma.parametro.findUnique({ where: { chiave: p.chiave } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.parametro.create({ data: p });
    created++;
    console.log(`  ✔ ${p.chiave} = ${p.valore}`);
  }

  console.log(`\nCreati: ${created}, già esistenti: ${skipped}`);
  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
