// scripts/fix-destinazione-from-sheet.js
// Popola il campo "destinazione" dei contratti con il valore della colonna N
// ("Fanta Presidente") del foglio Giocatore nel foglio principale.
"use strict";
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { PrismaPg }     = require("@prisma/adapter-pg");
const { Pool }         = require("pg");

const SHEET_ID = "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent("Giocatore")}&range=A1:T500`;

function parseCSVLine(line) {
  const result = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur); cur = "";
    } else { cur += ch; }
  }
  result.push(cur);
  return result;
}

async function main() {
  // 1) Fetch sheet
  console.log("Fetching foglio Giocatore...");
  const res = await fetch(CSV_URL);
  if (!res.ok) { console.error("HTTP error", res.status); process.exit(1); }
  const text = await res.text();
  const lines = text.split("\n").map(l => l.replace(/\r$/, "")).filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  console.log("Colonne:", headers.map((h, i) => `[${i}]${h}`).join(" | "));

  // Col C (index 2) = Nome, Col N (index 13) = Fanta Presidente
  // Ma range starts at A, so Nome = col index 2, Fanta Presidente = col index 13
  const iNome = 2;  // column C
  const iDest = 13; // column N

  // Build map nome -> presidente
  const sheetMap = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const nome = (cols[iNome] || "").trim();
    const pres = (cols[iDest] || "").trim();
    if (nome && pres) {
      sheetMap[nome.toLowerCase()] = pres;
    }
  }
  console.log(`\nGiocatori con Fanta Presidente nel foglio: ${Object.keys(sheetMap).length}`);

  // 2) Connect to DB
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // 3) Find contracts with null destinazione
  const contratti = await prisma.contratto.findMany({
    where: { destinazione: null },
    include: { giocatore: { select: { nome: true } } }
  });
  console.log(`Contratti con destinazione NULL: ${contratti.length}`);

  // 4) Update where we have a match
  let updated = 0;
  let noMatch = [];
  for (const c of contratti) {
    const nome = c.giocatore.nome;
    const dest = sheetMap[nome.toLowerCase()];
    if (dest) {
      await prisma.contratto.update({
        where: { id: c.id },
        data: { destinazione: dest }
      });
      updated++;
      console.log(`  ✔ [${c.id}] ${nome} → destinazione: "${dest}"`);
    } else {
      noMatch.push(nome);
    }
  }

  console.log(`\n=== Risultato ===`);
  console.log(`Aggiornati: ${updated}`);
  console.log(`Senza match nel foglio: ${noMatch.length}`);
  if (noMatch.length > 0) {
    console.log("  ", noMatch.join(", "));
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
