// prisma/seed-giocatori.js
// Importa tutti i giocatori dal foglio Google pubblico nella tabella `giocatori`.
// Esegui con: node prisma/seed-giocatori.js
"use strict";
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { PrismaPg }     = require("@prisma/adapter-pg");

const SHEET_ID  = "1LY5jlGtdId9l2moK5mwNNj1OR5BBEFQqS_jHaqyov_c";
const SHEET_TAB = "Giocatore";
const CSV_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}&range=A:K`;

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .map(parseCSVLine);
}

// ── column finder (case-insensitive, accent-insensitive) ──────────────────────
function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[àáâä]/g, "a")
    .replace(/[èéêë]/g, "e")
    .replace(/[ìíîï]/g, "i")
    .replace(/[òóôö]/g, "o")
    .replace(/[ùúûü]/g, "u")
    .replace(/[^a-z0-9]/g, "");
}

function findCol(headers, ...candidates) {
  const normH = headers.map(norm);
  for (const c of candidates) {
    const idx = normH.indexOf(norm(c));
    if (idx !== -1) return idx;
  }
  return -1;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Fetching giocatori da Google Sheets...");
  console.log("URL:", CSV_URL);

  const res = await fetch(CSV_URL);

  if (!res.ok) {
    console.error(`\nErrore HTTP ${res.status}: ${res.statusText}`);
    console.error("Assicurati che il foglio sia condiviso con 'Chiunque con il link può visualizzare'.");
    process.exit(1);
  }

  const text = await res.text();

  if (text.includes("accounts.google.com") || text.includes("ServiceLogin")) {
    console.error("\n❌ Il foglio non è pubblico.");
    console.error("   Vai su File > Condividi > Chiunque con il link > Visualizzatore.");
    process.exit(1);
  }

  const rows = parseCSV(text);
  if (rows.length < 2) {
    console.error("❌ Foglio vuoto o non leggibile.");
    process.exit(1);
  }

  const headers = rows[0];
  console.log("\nColonne trovate:", headers.map((h, i) => `[${i}]${h || "(vuota)"}`).join("  "));
  // Mostra la prima riga dati per capire la struttura reale
  if (rows[1]) console.log("Prima riga dati:  ", rows[1].map((v, i) => `[${i}]${v || "(vuota)"}`).join("  "));

  // Trova indici colonne (con alias comuni)
  const iNome        = findCol(headers, "nome", "name", "giocatore", "player");
  const iRuoloEsteso = findCol(headers, "ruoloEsteso", "ruolo esteso", "ruoloe", "RuoloExt", "portiere", "difensore");
  const iRuolo       = findCol(headers, "ruolo", "r", "role", "pos");
  const iSquadra     = findCol(headers, "squadra", "club", "team", "società", "societa");
  const iEta           = findCol(headers, "età", "eta", "age");
  const iAnniContratto  = findCol(headers, "anni contratto", "annicontratto", "anni_contratto", "durata contratto");
  const iValore         = findCol(headers, "valore", "quotazione", "quota", "val", "costo");

  if (iNome === -1) {
    console.error("\n❌ Colonna 'Nome' non trovata tra le colonne disponibili.");
    console.error("   Controlla le intestazioni del foglio e aggiorna il mapping nel file seed-giocatori.js");
    process.exit(1);
  }

  console.log("\nMapping colonne:");
  console.log(`  nome        → colonna ${iNome}`);
  console.log(`  ruoloEsteso → colonna ${iRuoloEsteso === -1 ? "non trovata" : iRuoloEsteso}`);
  console.log(`  ruolo       → colonna ${iRuolo       === -1 ? "non trovata" : iRuolo}`);
  console.log(`  squadra     → colonna ${iSquadra     === -1 ? "non trovata" : iSquadra}`);
  console.log(`  eta          → colonna ${iEta           === -1 ? "non trovata" : iEta}`);
  console.log(`  anniContratto→ colonna ${iAnniContratto  === -1 ? "non trovata" : iAnniContratto}`);
  console.log(`  valore       → colonna ${iValore         === -1 ? "non trovata" : iValore}`);

  // Costruisce i record
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r    = rows[i];
    const nome = (r[iNome] || "").trim();
    if (!nome) continue; // salta righe vuote

    const etaRaw          = iEta           !== -1 ? (r[iEta]           || "").replace(/[^\d]/g, "") : "";
    const anniContrattoRaw = iAnniContratto  !== -1 ? (r[iAnniContratto] || "").replace(/[^\d]/g, "") : "";
    const valoreRaw       = iValore         !== -1 ? (r[iValore]        || "").replace(",", ".").replace(/[^\d.]/g, "") : "";

    const eta          = etaRaw          ? parseInt(etaRaw,          10) : null;
    const anniContratto = anniContrattoRaw ? parseInt(anniContrattoRaw, 10) : null;
    const valore       = valoreRaw       ? parseFloat(valoreRaw)          : null;

    const ruoloRaw = iRuolo !== -1 ? (r[iRuolo] || "").trim() : "";
    // Ruolo: prende solo il primo carattere, deve essere P/D/C/A
    const ruolo = ruoloRaw ? ruoloRaw.charAt(0).toUpperCase() : "?";

    records.push({
      nome,
      ruoloEsteso: iRuoloEsteso !== -1 ? ((r[iRuoloEsteso] || "").trim() || null) : null,
      ruolo,
      squadra:     iSquadra     !== -1 ? ((r[iSquadra]     || "").trim() || null) : null,
      eta:          Number.isFinite(eta)          ? eta          : null,
      anniContratto: Number.isFinite(anniContratto) ? anniContratto : null,
      valore:       Number.isFinite(valore)        ? valore       : null,
      active:       true,
    });
  }

  console.log(`\nRecord validi pronti per l'inserimento: ${records.length}`);

  if (records.length === 0) {
    console.error("❌ Nessun record trovato. Controlla il foglio.");
    process.exit(1);
  }

  // Connessione DB
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma  = new PrismaClient({ adapter });

  try {
    // Carica tutti i giocatori esistenti indicizzati per nome (case-insensitive)
    const existing = await prisma.giocatore.findMany();
    const byNome = {};
    for (const g of existing) {
      byNome[g.nome.toLowerCase()] = g;
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let deactivated = 0;

    for (const rec of records) {
      const key = rec.nome.toLowerCase();
      const found = byNome[key];

      if (found) {
        // Aggiorna solo se qualcosa è cambiato, preservando l'ID
        const changed =
          found.ruolo       !== rec.ruolo       ||
          found.ruoloEsteso !== rec.ruoloEsteso  ||
          found.squadra     !== rec.squadra      ||
          found.eta         !== rec.eta          ||
          found.anniContratto !== rec.anniContratto ||
          String(found.valore ?? "") !== String(rec.valore ?? "") ||
          found.active      !== true;

        if (changed) {
          await prisma.giocatore.update({
            where: { id: found.id },
            data: {
              ruolo:       rec.ruolo,
              ruoloEsteso: rec.ruoloEsteso,
              squadra:     rec.squadra,
              eta:         rec.eta,
              anniContratto: rec.anniContratto,
              valore:      rec.valore,
              active:      true,
            },
          });
          updated++;
          process.stdout.write(`\rAggiornati ${updated}, creati ${created}...`);
        } else {
          unchanged++;
        }
        // rimuove dal map: chi rimane alla fine non era nel foglio
        delete byNome[key];
      } else {
        await prisma.giocatore.create({ data: rec });
        created++;
        process.stdout.write(`\rAggiornati ${updated}, creati ${created}...`);
      }
    }

    // Giocatori non presenti nel foglio → active = false
    const missingIds = Object.values(byNome)
      .filter(g => g.active)   // solo quelli ancora attivi
      .map(g => g.id);

    if (missingIds.length > 0) {
      await prisma.giocatore.updateMany({
        where: { id: { in: missingIds } },
        data:  { active: false },
      });
      deactivated = missingIds.length;
    }

    console.log(`\n\n✅ Importazione completata:`);
    console.log(`   🆕 Nuovi inseriti  : ${created}`);
    console.log(`   ✏️  Aggiornati     : ${updated}`);
    console.log(`   ✔  Invariati      : ${unchanged}`);
    console.log(`   🚫 Disattivati    : ${deactivated}`);
    console.log(`   📦 Totale in DB   : ${created + updated + unchanged + deactivated}`);

    // Mostra sample
    const sample = await prisma.giocatore.findMany({ take: 3 });
    console.log("\nPrimi 3 record:");
    sample.forEach((g) =>
      console.log(`  [${g.id}] ${g.nome} | ${g.ruolo} | ${g.squadra || "-"} | età ${g.eta ?? "-"} | €${g.valore ?? "-"}`)
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("\nErrore fatale:", err.message || err);
  process.exit(1);
});
