/**
 * scripts/import-riepilogoEx.js
 *
 * Legge il tab "riepilogoEx" dal Google Spreadsheet e salva la situazione
 * finanziaria di ogni presidente nella tabella `situazione_finanziaria`.
 *
 * La colonna "User" contiene il nome del presidente (non del fantaTeam).
 * Il collegamento con il FantaTeam (fantaTeamId) va fatto manualmente
 * dall'admin via interfaccia web dopo l'import.
 *
 * Uso:
 *   node scripts/import-riepilogoEx.js                     (stagione corrente: 2025-2026)
 *   node scripts/import-riepilogoEx.js --stagione 2024-2025
 *   node scripts/import-riepilogoEx.js --dry-run
 */

"use strict";

require("dotenv").config();
const https = require("https");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";
const DRY_RUN = process.argv.includes("--dry-run");

const stageArg = process.argv.find((a) => a.startsWith("--stagione="));
const STAGIONE = stageArg ? stageArg.split("=")[1] : "2025-2026";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fetchCSV(sheetName) {
  return new Promise((resolve, reject) => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseCSV(text) {
  return text.split("\n").map((l) => parseCSVLine(l.replace(/\r$/, "")));
}

function toDecimal(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ─── Prisma ──────────────────────────────────────────────────────────────────

function createPrisma() {
  const ssl = process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false;
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: ssl || undefined });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n📊  Import riepilogoEx → stagione ${STAGIONE}${DRY_RUN ? " [DRY-RUN]" : ""}`);

  const csv = await fetchCSV("riepilogoEx");
  const rows = parseCSV(csv);

  if (rows.length < 2) {
    console.error("❌  Foglio vuoto o non trovato.");
    process.exit(1);
  }

  // mappa header → indice
  const header = rows[0].map((h) => h.trim());
  console.log("Intestazioni trovate:", header);

  const idx = {
    nomePresidente:    header.indexOf("User"),
    valoreRose:        header.indexOf("Valore Rose"),
    crediti:           header.indexOf("Crediti"),
    patrimonio:        header.indexOf("Patrimonio (Rose+Crediti)"),
    giocatoriTes:      header.indexOf("Giocatori Tesserati"),
    etaMedia:          header.indexOf("Età Media"),
    stipendi:          header.indexOf("Stipendi"),
    montePrestiti:     header.findIndex((h) => h.startsWith("Monte prestiti")),
    ultimoPlusMinus:   header.findIndex((h) => h.includes("Plus")),
  };

  // verifica che tutte le colonne siano state trovate
  for (const [key, i] of Object.entries(idx)) {
    if (i === -1) {
      console.error(`❌  Colonna non trovata per il campo "${key}". Verifica il foglio.`);
      process.exit(1);
    }
  }

  const dataRows = rows.slice(1).filter((r) => r.some((c) => c !== ""));

  console.log(`\nRighe dati trovate: ${dataRows.length}`);

  const records = dataRows.map((r) => ({
    nomePresidente:     r[idx.nomePresidente],
    stagione:           STAGIONE,
    valoreRose:         toDecimal(r[idx.valoreRose]),
    crediti:            toDecimal(r[idx.crediti]),
    patrimonio:         toDecimal(r[idx.patrimonio]),
    giocatoriTesserati: parseInt(r[idx.giocatoriTes]) || 0,
    etaMedia:           toDecimal(r[idx.etaMedia]),
    stipendi:           toDecimal(r[idx.stipendi]),
    montePrestiti:      toDecimal(r[idx.montePrestiti]),
    ultimoPlusMinus:    toDecimal(r[idx.ultimoPlusMinus]),
    fantaTeamId:        null,
  }));

  console.log("\nAnteprima record:");
  records.forEach((rec) => console.log(" •", rec.nomePresidente, "→ patrimonio:", rec.patrimonio));

  if (DRY_RUN) {
    console.log("\n⚠️  DRY-RUN: nessuna scrittura su DB.");
    return;
  }

  const prisma = createPrisma();

  let creati = 0;
  let aggiornati = 0;

  for (const rec of records) {
    const existing = await prisma.situazioneFinanziaria.findFirst({
      where: { nomePresidente: rec.nomePresidente, stagione: rec.stagione },
    });

    if (existing) {
      await prisma.situazioneFinanziaria.update({
        where: { id: existing.id },
        data: rec,
      });
      aggiornati++;
      console.log(`↻  Aggiornato: ${rec.nomePresidente} (${rec.stagione})`);
    } else {
      await prisma.situazioneFinanziaria.create({ data: rec });
      creati++;
      console.log(`✔  Creato: ${rec.nomePresidente} (${rec.stagione})`);
    }
  }

  await prisma.$disconnect();
  console.log(`\n✅  Import completato — creati: ${creati}, aggiornati: ${aggiornati}`);
})();
