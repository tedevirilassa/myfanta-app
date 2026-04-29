"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const SHEET_ID  = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";
const SHEET_TAB = "Giocatore";
const CSV_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}&range=A:L`;

function parseCSVLine(line) {
  const result = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function normName(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function main() {
  console.log(`Scarico il foglio '${SHEET_TAB}'...`);
  const res = await fetch(CSV_URL);
  if (!res.ok) { console.error(`Errore HTTP ${res.status}`); process.exit(1); }
  const text = await res.text();

  const rows = text.split("\n").map(l => parseCSVLine(l.replace(/\r$/, "")));
  // Struttura: [0]RuoloEsteso [1]Ruolo [2]Nome [3]Squadra [4]ValoreAcquisto [5]Stipendio [6]Età [7]ValoreAgg [8]QuotPrec [9]DataAcquisto [10]AnniContratto [11]Scadenza
  const I_NOME = 2, I_ANNI = 10;

  const dataRows = rows.slice(1).filter(r => r[I_NOME] && r[I_NOME].trim() && r[I_ANNI] && r[I_ANNI].trim());
  console.log(`Righe valide trovate: ${dataRows.length}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const tuttiGiocatori = await prisma.giocatore.findMany({ select: { id: true, nome: true } });
  const byNome = new Map(tuttiGiocatori.map(g => [normName(g.nome), g.id]));

  let aggiornati = 0, nonTrovati = [];

  for (const row of dataRows) {
    const nome = row[I_NOME].trim();
    const anni = parseInt(row[I_ANNI].replace(/[^\d]/g, ""), 10);
    if (!nome || !Number.isFinite(anni)) continue;

    const id = byNome.get(normName(nome));
    if (!id) { nonTrovati.push(nome); continue; }

    await prisma.giocatore.update({ where: { id }, data: { anniContratto: anni } });
    aggiornati++;
    console.log(`  [OK] ${nome.padEnd(30)} → anniContratto: ${anni}`);
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`Aggiornati:    ${aggiornati}`);
  console.log(`Non trovati:   ${nonTrovati.length}`);
  if (nonTrovati.length) console.log("  " + nonTrovati.join("\n  "));

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
