"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";

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

function normalizeName(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function fetchCSV(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} per sheet "${sheetName}"`);
  return res.text();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("⚠️  DRY-RUN: nessuna modifica al DB\n");

  console.log("Scarico il foglio 'Diario'...");
  const csv = await fetchCSV("Diario");
  const rows = csv.split("\n").map(l => parseCSVLine(l.replace(/\r$/, "")));

  // col0=nome, col1=operazione, col2=da, col3=a, col4=importoAcquisto
  // Costruiamo una mappa nome → importoAcquisto (ultima riga con valore > 0 vince)
  const prezzoMap = new Map(); // normName → importoAcquisto

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const nome = normalizeName(r[0]);
    const importo = parseFloat((r[4] || "").replace(",", "."));
    if (!isNaN(importo) && importo > 0) {
      prezzoMap.set(nome, importo);
    }
  }

  console.log(`Prezzo acquisto trovato per ${prezzoMap.size} giocatori nel Diario.\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const contratti = await prisma.contratto.findMany({
    include: { giocatore: { select: { nome: true } } },
  });

  let aggiornati = 0, invariati = 0, nonTrovati = [];

  for (const c of contratti) {
    const key = normalizeName(c.giocatore.nome);
    const prezzo = prezzoMap.get(key);

    if (prezzo === undefined) {
      nonTrovati.push(c.giocatore.nome);
      invariati++;
      continue;
    }

    // Controlla se è già valorizzato
    const attuale = c.prezzoAcquisto ? parseFloat(c.prezzoAcquisto) : null;
    if (attuale === prezzo) {
      invariati++;
      continue;
    }

    console.log(`  [OK] ${c.giocatore.nome.padEnd(30)} prezzo: ${prezzo}`);

    if (!dryRun) {
      await prisma.contratto.update({
        where: { id: c.id },
        data: { prezzoAcquisto: prezzo },
      });
    }
    aggiornati++;
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Contratti aggiornati:  ${aggiornati}`);
  console.log(`Invariati/senza dato:  ${invariati}`);
  if (nonTrovati.length) {
    const unici = [...new Set(nonTrovati)];
    console.log(`Non trovati in Diario (${unici.length}):`);
    unici.slice(0, 15).forEach(n => console.log(`    - ${n}`));
    if (unici.length > 15) console.log(`    ... e altri ${unici.length - 15}`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
