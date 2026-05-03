/**
 * scripts/import-sheet77.js
 *
 * Legge il foglio Google Sheets "Sheet80" e crea il FantaTeam "Giannik"
 * + i contratti per tutti i giocatori della rosa.
 *
 * Uso: node scripts/import-Sheet80.js
 *      node scripts/import-Sheet80.js --dry-run
 */

"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";
const TEAM_NAME = "Giannik";
const SHEET_NAME = "Sheet80";
const DRY_RUN = process.argv.includes("--dry-run");

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

function parseCSV(text) {
  return text.split("\n").map(l => parseCSVLine(l.replace(/\r$/, "")));
}

function normalizeName(n) {
  return n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function pf(v) { const n = parseFloat((v || "").replace(",", ".")); return isNaN(n) ? null : n; }

/** "07/2025" → "07-2025" */
function formatDate(raw) {
  if (!raw || !raw.includes("/")) return null;
  return raw.replace("/", "-");
}

async function fetchCSV(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} per sheet "${sheetName}"`);
  return res.text();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log("⚠️  DRY-RUN: nessuna modifica al DB\n");

  // 1. Fetch sheet
  console.log(`Scarico il foglio '${SHEET_NAME}'...`);
  const csv = await fetchCSV(SHEET_NAME);
  const rows = parseCSV(csv);

  // 2. Fetch Diario per provenienza/destinazione + prezzoAcquisto
  console.log("Scarico il foglio 'Diario'...");
  const diarioCsv = await fetchCSV("Diario");
  const diarioRows = parseCSV(diarioCsv);

  const provMap = new Map();
  const destMap = new Map();
  const prezzoMap = new Map();
  for (let i = 1; i < diarioRows.length; i++) {
    const r = diarioRows[i];
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
    const importo = pf(r[4]);
    if (importo !== null && importo > 0) prezzoMap.set(nome, importo);
  }

  // 3. Filtra righe con ruolo valido
  // Colonne Sheet77:
  //  0=RuoloEsteso, 1=Ruolo, 2=Nome, 3=Squadra, 4=Stipendio,
  //  5=ValoreAcquisto, 6=Età, 7=ValoreAggiornato, 8=QuotPrec,
  //  9=Comprato/Rinnovato(MM/YYYY), 10=AnniContrattoRimanenti, 11=Scadenza(MM/YYYY)
  const RUOLI = new Set(["P", "D", "C", "A"]);
  const playerRows = rows.filter(r => RUOLI.has(r[1]) && r[2]);
  console.log(`Trovate ${playerRows.length} righe giocatori.\n`);

  // 4. Connessione DB
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // 5. Trova o crea il FantaTeam
  let team = await prisma.fantaTeam.findFirst({
    where: { nome: { contains: TEAM_NAME, mode: "insensitive" } },
  });
  if (!team) {
    if (!DRY_RUN) {
      team = await prisma.fantaTeam.create({ data: { nome: TEAM_NAME } });
      console.log(`FantaTeam creato: ${team.nome} (id: ${team.id})`);
    } else {
      console.log(`[DRY RUN] FantaTeam "${TEAM_NAME}" verrebbe creato.`);
      team = { id: 0, nome: TEAM_NAME };
    }
  } else {
    console.log(`FantaTeam trovato: ${team.nome} (id: ${team.id})`);
  }

  // 6. Carica giocatori dal DB
  const tuttiGiocatori = await prisma.giocatore.findMany();
  const giocatoriMap = new Map(tuttiGiocatori.map(g => [normalizeName(g.nome), g]));

  // 7. Rimuovi contratti esistenti per questo team (reimport pulito)
  if (!DRY_RUN && team.id) {
    const deleted = await prisma.contratto.deleteMany({ where: { fantaTeamId: team.id } });
    if (deleted.count > 0) console.log(`Rimossi ${deleted.count} contratti precedenti.\n`);
  }

  // 8. Crea contratti
  const notFound = [];
  const autoCreated = [];
  let created = 0;

  for (const row of playerRows) {
    const nome         = row[2];
    const ruolo        = row[1];
    const squadra      = row[3];
    const stipendio    = pf(row[4]);
    const valoreAcq    = pf(row[5]);       // Valore All'Acquisto (prezzoAcquisto)
    const valoreAgg    = pf(row[7]);       // Valore Aggiornato (valoreGiocatore)
    const anniRim      = parseInt(row[10]) || 1;
    const scadenzaRaw  = row[11];          // "07/2026"
    const stipulaRaw   = row[9];           // "07/2025"

    const dataStipula = formatDate(stipulaRaw) || "07-2025";
    const dataFine    = formatDate(scadenzaRaw) || null;

    // Calcola durataContratto dalla differenza scadenza - stipula
    let durata = anniRim;
    if (dataFine && dataStipula) {
      const annoFine = parseInt(dataFine.split("-")[1]);
      const annoStip = parseInt(dataStipula.split("-")[1]);
      if (annoFine > annoStip) durata = annoFine - annoStip;
    }

    // Match giocatore nel DB
    const key = normalizeName(nome);
    let giocatore = giocatoriMap.get(key);

    // Fallback: cognome + ruolo
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
      // Auto-crea giocatore con dati disponibili dal foglio
      if (!DRY_RUN) {
        giocatore = await prisma.giocatore.create({
          data: {
            nome:       nome.trim(),
            ruolo,
            ruoloEsteso: row[0] || null,
            squadra:    squadra || null,
            eta:        parseInt(row[6]) || null,
            valore:     valoreAgg,
            active:     true,
          },
        });
        giocatoriMap.set(key, giocatore);
        autoCreated.push({ nome, ruolo, squadra, id: giocatore.id });
        console.log(`  [CREATO] ${nome} (${ruolo}) \u2192 giocatore id ${giocatore.id}`);
      } else {
        autoCreated.push({ nome, ruolo, squadra, id: 0 });
        console.log(`  [DRY RUN] Verrebbe creato: ${nome} (${ruolo})`);
        continue;
      }
    }

    const provKey = normalizeName(nome);
    const prov = provMap.get(provKey) ?? null;
    const dest = destMap.get(provKey) ?? null;
    const prezzoDiario = prezzoMap.get(provKey) ?? null;

    console.log(
      `  [OK] ${nome.padEnd(28)} gId=${String(giocatore.id).padStart(4)}` +
      `  stip=${dataStipula}  fine=${dataFine || "-"}  durata=${durata}` +
      `  val=${valoreAgg ?? "-"}  prezzo=${valoreAcq ?? "-"}  stip=${stipendio ?? "-"}`
    );

    if (!DRY_RUN) {
      await prisma.contratto.create({
        data: {
          tipo:              "Acquisto",
          dataStipula,
          durataContratto:   durata,
          dataFine,
          giocatoreId:       giocatore.id,
          fantaTeamId:       team.id,
          valoreGiocatore:   valoreAgg,
          importoOperazione: stipendio,
          prezzoAcquisto:    valoreAcq ?? prezzoDiario,
          provenienza:       prov,
          destinazione:      dest,
        },
      });
      created++;
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`FantaTeam:              ${team.nome} (id: ${team.id})`);
  console.log(`Contratti creati:       ${DRY_RUN ? "(dry run)" : created}`);
  console.log(`Giocatori auto-creati:  ${autoCreated.length}`);

  if (autoCreated.length > 0) {
    console.log("\nGiocatori creati automaticamente (dati parziali):");
    autoCreated.forEach(g => console.log(`  - [${g.ruolo}] ${g.nome} (id: ${g.id})`));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error("\nERRORE:", e.message); process.exit(1); });
