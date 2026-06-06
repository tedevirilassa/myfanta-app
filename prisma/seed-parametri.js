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
  { chiave: "stipendio_percentuale", valore: "0.10", descrizione: "Percentuale stipendio sessione estiva (es. 0.10 = 10%)" },
  { chiave: "stipendio_percentuale_invernale", valore: "0.05", descrizione: "Percentuale stipendio sessione invernale (es. 0.05 = 5%)" },
  { chiave: "mercato_invernale_inizio", valore: "01-01", descrizione: "Inizio sessione invernale (GG-MM)" },
  { chiave: "mercato_invernale_fine", valore: "15-02", descrizione: "Fine sessione invernale (GG-MM)" },
  { chiave: "mercato_estivo_inizio", valore: "01-07", descrizione: "Inizio sessione estiva (GG-MM)" },
  { chiave: "mercato_estivo_fine", valore: "15-09", descrizione: "Fine sessione estiva (GG-MM)" },
  { chiave: "mercato_privato_inizio", valore: "01-07", descrizione: "Inizio finestra acquisti tra presidenti (GG-MM)" },
  { chiave: "mercato_privato_fine", valore: "15-02", descrizione: "Fine finestra acquisti tra presidenti (GG-MM)" },

  // ── Budget ──
  { chiave: "budget_iniziale", valore: "100", descrizione: "Budget iniziale per presidente (M)" },

  // ── Prezzi acquisto ──
  { chiave: "contratto_prezzo_min_pct", valore: "0.60", descrizione: "Coefficiente minimo prezzo acquisto rispetto alla quotazione TM (es. 0.60 = 60%)" },
  { chiave: "contratto_prezzo_max_pct", valore: "1.40", descrizione: "Coefficiente massimo prezzo acquisto rispetto alla quotazione TM (es. 1.40 = 140%)" },

  // ── Prestiti ──
  { chiave: "prestiti_corrispettivo_min", valore: "0.10", descrizione: "Corrispettivo minimo per un singolo prestito (M)" },

  // ── Mercato P2P ──
  { chiave: "mercato_p2p_delta",           valore: "0.40", descrizione: "Variazione massima nelle offerte P2P rispetto al valore di mercato (es. 0.40 = ±40%)" },
  { chiave: "mercato_p2p_scadenza_giorni", valore: "7",    descrizione: "Giorni di validità di un'offerta P2P prima della scadenza automatica" },

  // ── Rinnovi / Salary cap ──
  { chiave: "rinnovi_salary_cap_pct", valore: "0.25", descrizione: "Percentuale del valore medio rosa usata come base per il salary cap rinnovi (es. 0.25 = 25%)" },

  // ── Premi classifica ──
  { chiave: "premi_classifica_blocco_giorni", valore: "30",   descrizione: "Giorni minimi tra due erogazioni consecutive dei premi classifica" },
  { chiave: "premi_class_pos_1",  valore: "0.53", descrizione: "Premio classifica: coefficiente posizione 1  (moltiplicatore × max quotazione)" },
  { chiave: "premi_class_pos_2",  valore: "0.61", descrizione: "Premio classifica: coefficiente posizione 2" },
  { chiave: "premi_class_pos_3",  valore: "0.67", descrizione: "Premio classifica: coefficiente posizione 3" },
  { chiave: "premi_class_pos_4",  valore: "0.71", descrizione: "Premio classifica: coefficiente posizione 4" },
  { chiave: "premi_class_pos_5",  valore: "0.73", descrizione: "Premio classifica: coefficiente posizione 5" },
  { chiave: "premi_class_pos_6",  valore: "0.76", descrizione: "Premio classifica: coefficiente posizione 6" },
  { chiave: "premi_class_pos_7",  valore: "0.91", descrizione: "Premio classifica: coefficiente posizione 7" },
  { chiave: "premi_class_pos_8",  valore: "0.93", descrizione: "Premio classifica: coefficiente posizione 8" },
  { chiave: "premi_class_pos_9",  valore: "1.16", descrizione: "Premio classifica: coefficiente posizione 9" },
  { chiave: "premi_class_pos_10", valore: "1.23", descrizione: "Premio classifica: coefficiente posizione 10" },

  // ── Stagione ──
  { chiave: "stagione_inizio", valore: "01-07", descrizione: "Data inizio stagione (GG-MM)" },
  { chiave: "stagione_fine",   valore: "15-06", descrizione: "Data fine stagione (GG-MM)" },
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
