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
  console.log("Scarico il foglio 'Diario'...");
  const csv = await fetchCSV("Diario");
  const rows = csv.split("\n").map(l => parseCSVLine(l.replace(/\r$/, "")));

  // col0=nome, col1=operazione, col2=provenienza(Da), col3=destinazione(A)
  // Scansione in avanti: ogni riga SOVRASCRIVE la precedente → ultima riga vince
  const provMap = new Map();  // nome → provenienza
  const destMap = new Map();  // nome → destinazione

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const nome = normalizeName(r[0]);

    if (r[2] && r[2].trim()) {
      const da = r[2].trim();
      provMap.set(nome, /^libero$/i.test(da) ? "Pubblico" : da);
    }
    if (r[3] && r[3].trim()) {
      const a = r[3].trim();
      destMap.set(nome, /^libero$/i.test(a) ? "Pubblico" : a);
    }
  }

  console.log(`Provenienza trovata per ${provMap.size} giocatori nel Diario.`);
  console.log(`Destinazione trovata per ${destMap.size} giocatori nel Diario.\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // Carica tutti i contratti con il nome del giocatore
  const contratti = await prisma.contratto.findMany({
    include: { giocatore: { select: { nome: true } } },
  });

  let aggiornati = 0, invariati = 0, nonTrovati = [];

  for (const c of contratti) {
    const key = normalizeName(c.giocatore.nome);
    const prov = provMap.get(key) ?? null;
    const dest = destMap.get(key) ?? null;

    if (prov === null && dest === null) {
      nonTrovati.push(c.giocatore.nome);
      // Non presenti nel Diario → NULL esplicito su entrambi i campi
      await prisma.contratto.update({
        where: { id: c.id },
        data: { provenienza: null, destinazione: null },
      });
      invariati++;
      continue;
    }

    await prisma.contratto.update({
      where: { id: c.id },
      data: { provenienza: prov, destinazione: dest },
    });
    aggiornati++;
    console.log(
      `  [OK] ${c.giocatore.nome.padEnd(30)} prov: ${(prov || "NULL").padEnd(15)} dest: ${dest || "NULL"}`
    );
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Contratti aggiornati:  ${aggiornati}`);
  console.log(`Non trovati in Diario: ${invariati}`);
  if (nonTrovati.length) {
    const unici = [...new Set(nonTrovati)];
    console.log("  Giocatori senza dati nel Diario:");
    unici.forEach(n => console.log(`    - ${n}`));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
