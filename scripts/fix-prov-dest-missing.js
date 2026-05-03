"use strict";
// Popola provenienza e destinazione SOLO per i contratti che le hanno NULL,
// leggendo prima dal foglio Diario (colonna C = Provenienza, colonna D = Destinazione),
// poi da DiarioVecchio per i giocatori non trovati nel Diario.
// Non sovrascrive MAI dati già presenti nel DB.
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

function buildMaps(rows) {
  const provMap = new Map();
  const destMap = new Map();
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
  return { provMap, destMap };
}

async function main() {
  // ── 1. Carica Diario ────────────────────────────────────────────────────────
  console.log("Scarico il foglio 'Diario'...");
  const csvDiario = await fetchCSV("Diario");
  const rowsDiario = csvDiario.split("\n").map(l => parseCSVLine(l.replace(/\r$/, "")));
  const { provMap: provDiario, destMap: destDiario } = buildMaps(rowsDiario);
  console.log(`Diario        → prov: ${provDiario.size} giocatori, dest: ${destDiario.size} giocatori`);

  // ── 2. Carica DiarioVecchio ─────────────────────────────────────────────────
  console.log("Scarico il foglio 'DiarioVecchio'...");
  const csvVecchio = await fetchCSV("DiarioVecchio");
  const rowsVecchio = csvVecchio.split("\n").map(l => parseCSVLine(l.replace(/\r$/, "")));
  const { provMap: provVecchio, destMap: destVecchio } = buildMaps(rowsVecchio);
  console.log(`DiarioVecchio → prov: ${provVecchio.size} giocatori, dest: ${destVecchio.size} giocatori\n`);

  // ── 3. Connessione DB ───────────────────────────────────────────────────────
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // Carica solo contratti con provenienza NULL oppure destinazione NULL
  const contratti = await prisma.contratto.findMany({
    where: {
      OR: [
        { provenienza: null },
        { destinazione: null },
      ],
    },
    include: { giocatore: { select: { nome: true } } },
  });

  console.log(`Contratti con provenienza o destinazione mancante: ${contratti.length}`);

  if (contratti.length === 0) {
    console.log("Nessun contratto da aggiornare.");
    await prisma.$disconnect();
    return;
  }

  // ── 4. Aggiornamento ─────────────────────────────────────────────────────────
  // Priorità: Diario > DiarioVecchio. Non si sovrascrivono mai valori già presenti.
  // DiarioVecchio viene consultato SOLO per i giocatori non trovati nel Diario.
  let aggiornatiDiario = 0, aggiornatiVecchio = 0, nonTrovati = [];

  for (const c of contratti) {
    const key = normalizeName(c.giocatore.nome);
    const data = {};

    if (c.provenienza === null) {
      const val = provDiario.get(key) ?? provVecchio.get(key) ?? null;
      if (val !== null) data.provenienza = val;
    }
    if (c.destinazione === null) {
      const val = destDiario.get(key) ?? destVecchio.get(key) ?? null;
      if (val !== null) data.destinazione = val;
    }

    if (Object.keys(data).length === 0) {
      // Non trovato in nessun diario → imposta "N.A." sui campi ancora NULL
      const naData = {};
      if (c.provenienza === null) naData.provenienza = "N.A.";
      if (c.destinazione === null) naData.destinazione = "N.A.";
      await prisma.contratto.update({ where: { id: c.id }, data: naData });
      nonTrovati.push(c.giocatore.nome);
      continue;
    }

    await prisma.contratto.update({ where: { id: c.id }, data });

    // Traccia fonte: se entrambi i valori vengono da DiarioVecchio (non presenti in Diario)
    const fromVecchio =
      (data.provenienza !== undefined && !provDiario.has(key)) ||
      (data.destinazione !== undefined && !destDiario.has(key));

    if (fromVecchio) {
      aggiornatiVecchio++;
      const pLabel = data.provenienza !== undefined ? `prov: "${data.provenienza}"` : `prov: (invariata)`;
      const dLabel = data.destinazione !== undefined ? `dest: "${data.destinazione}"` : `dest: (invariata)`;
      console.log(`  [VEC] ${c.giocatore.nome.padEnd(30)} ${pLabel.padEnd(28)} ${dLabel}`);
    } else {
      aggiornatiDiario++;
      const pLabel = data.provenienza !== undefined ? `prov: "${data.provenienza}"` : `prov: (invariata)`;
      const dLabel = data.destinazione !== undefined ? `dest: "${data.destinazione}"` : `dest: (invariata)`;
      console.log(`  [DIA] ${c.giocatore.nome.padEnd(30)} ${pLabel.padEnd(28)} ${dLabel}`);
    }
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Aggiornati da Diario:           ${aggiornatiDiario}`);
  console.log(`Aggiornati da DiarioVecchio:    ${aggiornatiVecchio}`);
  console.log(`Impostati a N.A.:               ${nonTrovati.length}`);
  if (nonTrovati.length) {
    const unici = [...new Set(nonTrovati)];
    unici.forEach(n => console.log(`    - ${n}`));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
