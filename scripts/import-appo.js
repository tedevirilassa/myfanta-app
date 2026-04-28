/**
 * scripts/import-appo.js
 *
 * Legge il foglio Google Sheets "appo" e crea i contratti di acquisto
 * per il FantaTeam "The President".
 *
 * Uso: node scripts/import-appo.js
 *      node scripts/import-appo.js --dry-run    (solo anteprima, nessuna scrittura)
 */

"use strict";

require("dotenv").config();
const https = require("https");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";
const DRY_RUN = process.argv.includes("--dry-run");

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

/** "07/2026" → { mm: "07", yyyy: "2026" } */
function parseScadenza(raw) {
  const [mm, yyyy] = raw.split("/");
  return { mm, yyyy };
}

/** Calcola dataStipula sottraendo anni da scadenza → "MM-YYYY" */
function calcolaStipula(scadenza, anni) {
  const { mm, yyyy } = parseScadenza(scadenza);
  return `${mm}-${parseInt(yyyy) - parseInt(anni)}`;
}

/** "07/2026" → "07-2026" */
function formatDataFine(scadenza) {
  return scadenza.replace("/", "-");
}

// ─── normalizzazione nome per matching ────────────────────────────────────────

function normalizeName(n) {
  return n
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // rimuove accenti
    .replace(/[^a-z0-9 ]/g, "")        // rimuove caratteri speciali
    .replace(/\s+/g, " ")
    .trim();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? "\n[DRY RUN] Nessuna scrittura su DB\n" : "");

  // 1. Fetch del foglio
  console.log("Scarico il foglio 'appo'...");
  const csv = await fetchCSV("appo");
  const rows = parseCSV(csv);

  // 2. Estrai solo le righe con ruolo valido (P, D, C, A) e nome
  const RUOLI_VALIDI = new Set(["P", "D", "C", "A"]);
  const playerRows = rows.filter((r) => RUOLI_VALIDI.has(r[1]) && r[2]);

  console.log(`Trovate ${playerRows.length} righe giocatori nel foglio.\n`);

  // 3. Connessione DB
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // 4. Trova il FantaTeam "The President"
  const team = await prisma.fantaTeam.findFirst({
    where: { nome: { contains: "president", mode: "insensitive" } },
  });
  if (!team) throw new Error("FantaTeam 'The President' non trovato nel DB.");
  console.log(`FantaTeam: ${team.nome} (id: ${team.id})\n`);

  // 5. Carica tutti i giocatori dal DB per il matching
  const tuttiGiocatori = await prisma.giocatore.findMany();
  const giocatoriMap = new Map(
    tuttiGiocatori.map((g) => [normalizeName(g.nome), g])
  );

  // 6. Elimina contratti esistenti per questo team (reimport pulito)
  if (!DRY_RUN) {
    const deleted = await prisma.contratto.deleteMany({
      where: { fantaTeamId: team.id },
    });
    if (deleted.count > 0) {
      console.log(`Rimossi ${deleted.count} contratti precedenti per questo team.\n`);
    }
  }

  // 7. Crea i contratti
  const notFound = [];
  let created = 0;

  for (const row of playerRows) {
    const [ruoloEsteso, ruolo, nome, squadra, stipendioRaw, valoreRaw, etaRaw, anniRaw, scadenzaRaw] = row;

    const anni = parseInt(anniRaw) || 1;
    const valore = parseFloat(valoreRaw) || null;
    const stipendio = parseFloat(stipendioRaw) || null;
    const scadenza = scadenzaRaw && scadenzaRaw.includes("/") ? scadenzaRaw : null;

    const dataStipula = scadenza ? calcolaStipula(scadenza, anni) : "07-2025";
    const dataFine = scadenza ? formatDataFine(scadenza) : null;

    // Cerca giocatore nel DB
    const key = normalizeName(nome);
    let giocatore = giocatoriMap.get(key);

    // Fallback: ricerca parziale (cognome)
    if (!giocatore) {
      const parts = key.split(" ");
      const cognome = parts[parts.length - 1];
      for (const [dbKey, dbG] of giocatoriMap) {
        if (dbKey.includes(cognome) && dbG.ruolo === ruolo) {
          giocatore = dbG;
          break;
        }
      }
    }

    if (!giocatore) {
      notFound.push({ nome, squadra, ruolo });
      console.warn(`  [NON TROVATO] ${nome} (${ruolo} - ${squadra})`);
      continue;
    }

    console.log(`  [OK] ${nome.padEnd(28)} → giocatore id ${String(giocatore.id).padStart(4)}  stipula: ${dataStipula}  fine: ${dataFine || "-"}  anni: ${anni}  valore: ${valore ?? "-"}`);

    if (!DRY_RUN) {
      await prisma.contratto.create({
        data: {
          tipo:             "Acquisto",
          dataStipula,
          durataContratto:  anni,
          dataFine,
          giocatoreId:      giocatore.id,
          fantaTeamId:      team.id,
          valoreGiocatore:  valore,
          importoOperazione: stipendio,
          provenienza:      "Pubblico",
        },
      });
      created++;
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Contratti creati:       ${DRY_RUN ? "(dry run)" : created}`);
  console.log(`Giocatori non trovati:  ${notFound.length}`);

  if (notFound.length > 0) {
    console.log("\nGiocatori da aggiungere manualmente alla tabella giocatori:");
    notFound.forEach((g) => console.log(`  - [${g.ruolo}] ${g.nome} (${g.squadra})`));
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("\nERRORE:", e.message);
  process.exit(1);
});
