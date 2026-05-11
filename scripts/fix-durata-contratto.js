/**
 * scripts/fix-durata-contratto.js
 *
 * Ricalcola durataContratto e dataFine per tutti i contratti validi,
 * usando la stessa logica degli import-sheet (Bope El Burro):
 *
 *   1. dataFine = "MM_STAGIONE-" + (annoInizioStagione + giocatore.anniContratto)
 *   2. durataContratto = annoFine - annoStipula  (se annoFine > annoStipula)
 *      oppure = giocatore.anniContratto  (se stessa year)
 *
 * Uso:
 *   node scripts/fix-durata-contratto.js            → applica le correzioni
 *   node scripts/fix-durata-contratto.js --dry-run   → mostra cosa farebbe senza scrivere
 */

"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  if (DRY_RUN) console.log("⚠️  DRY-RUN: nessuna modifica al DB\n");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // Leggi parametri stagione
  const paramRec = await prisma.parametro.findFirst({ where: { chiave: "stagione_inizio" } });
  const stagioneInizio = paramRec ? paramRec.valore : "01-07"; // GG-MM
  const meseInizio = parseInt(stagioneInizio.split("-")[1], 10) || 7;
  const mesePad = String(meseInizio).padStart(2, "0");

  // Calcola l'anno di inizio della stagione corrente
  const now = new Date();
  const annoInizioStagione = now.getMonth() + 1 >= meseInizio
    ? now.getFullYear()
    : now.getFullYear() - 1;

  console.log(`Stagione corrente: ${annoInizioStagione}-${annoInizioStagione + 1}`);
  console.log(`Mese inizio stagione: ${mesePad}\n`);

  // Carica tutti i contratti validi con giocatore
  const contratti = await prisma.contratto.findMany({
    where: { valido: true },
    include: {
      giocatore: { select: { id: true, nome: true, anniContratto: true } },
      fantaTeam: { select: { nome: true } },
    },
  });

  console.log(`Contratti validi trovati: ${contratti.length}\n`);

  let updated = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const c of contratti) {
    const anniContr = c.giocatore.anniContratto;

    if (anniContr == null || anniContr <= 0) {
      console.log(`  [SKIP] ${c.giocatore.nome.padEnd(28)} anniContratto=${anniContr ?? "NULL"}`);
      skipped++;
      continue;
    }

    // Calcola nuova dataFine: mese stagione + (annoInizioStagione + anniContratto)
    const nuovaDataFine = `${mesePad}-${annoInizioStagione + anniContr}`;

    // Calcola nuova durataContratto
    let nuovaDurata = anniContr;
    if (c.dataStipula && /^\d{2}-\d{4}$/.test(c.dataStipula)) {
      const annoStip = parseInt(c.dataStipula.split("-")[1], 10);
      const annoFine = annoInizioStagione + anniContr;
      if (annoFine > annoStip) {
        nuovaDurata = annoFine - annoStip;
      }
    }

    // Controlla se serve aggiornare
    if (c.dataFine === nuovaDataFine && c.durataContratto === nuovaDurata) {
      unchanged++;
      continue;
    }

    const oldFine = c.dataFine || "NULL";
    const oldDurata = c.durataContratto;
    const changed = [];
    if (c.dataFine !== nuovaDataFine) changed.push(`fine: ${oldFine} → ${nuovaDataFine}`);
    if (c.durataContratto !== nuovaDurata) changed.push(`durata: ${oldDurata} → ${nuovaDurata}`);

    console.log(
      `  [FIX] ${c.giocatore.nome.padEnd(28)} (${c.fantaTeam.nome.padEnd(25)})  ${changed.join("  |  ")}`
    );

    if (!DRY_RUN) {
      await prisma.contratto.update({
        where: { id: c.id },
        data: {
          dataFine: nuovaDataFine,
          durataContratto: nuovaDurata,
        },
      });
    }
    updated++;
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Contratti aggiornati:   ${DRY_RUN ? `(dry run) ${updated}` : updated}`);
  console.log(`Contratti invariati:    ${unchanged}`);
  console.log(`Contratti saltati:      ${skipped}`);
  console.log(`Totale validi:          ${contratti.length}`);

  await prisma.$disconnect();
  pool.end();
}

main().catch((e) => {
  console.error("\nERRORE:", e.message);
  console.error(e.stack);
  process.exit(1);
});
