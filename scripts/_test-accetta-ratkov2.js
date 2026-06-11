"use strict";
/**
 * Simula direttamente l'esecuzione di _eseguiTransferimento per la trattativa id=1 (Ratkov)
 * senza passare dall'HTTP, usando Prisma direttamente.
 */
require("dotenv").config();

const prisma = require("../src/lib/prisma");
const parametriService = require("../src/services/parametri.service");

// ── Copia esatta delle funzioni helper da mercato.controller.js ──────────────

function isDecorrenzaImmediata(dataDecorrenza) {
  const [mm, yyyy] = dataDecorrenza.split("-").map(Number);
  const oggi = new Date();
  return oggi.getFullYear() === yyyy && (oggi.getMonth() + 1) === mm;
}

function isDecorrenzaEstiva(dataDecorrenza) {
  const mm = parseInt((dataDecorrenza || "").split("-")[0], 10);
  if (!mm) return (new Date().getMonth() + 1) >= 7;
  return mm >= 7;
}

function calcolaStipendio(quotazioneValore, pct) {
  return Math.round(Number(quotazioneValore) * Number(pct) * 100) / 100;
}

function stagioneCorrente() {
  const oggi = new Date();
  const anno = oggi.getMonth() >= 6 ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return `${anno}-${anno + 1}`;
}

async function main() {
  // Fetch trattativa via Prisma (così dataDecorrenza viene convertita in MM-YYYY)
  const trattativa = await prisma.trattativaMercato.findUnique({
    where: { id: 1 },
    include: {
      giocatore:          { select: { id: true, nome: true, ruolo: true } },
      fantaTeamMittente:  { include: { user: { select: { id: true, nickname: true, email: true } } } },
      fantaTeamRicevente: { include: { user: { select: { id: true, nickname: true, email: true } } } },
    },
  });

  console.log("Trattativa (da Prisma):");
  console.log("  stato:", trattativa.stato);
  console.log("  dataDecorrenza:", trattativa.dataDecorrenza, "(tipo:", typeof trattativa.dataDecorrenza, ")");
  console.log("  anniContrattoProposti:", trattativa.anniContrattoProposti);
  console.log("  categoriaProposta:", trattativa.categoriaProposta);
  console.log("  importoOfferta:", trattativa.importoOfferta);
  console.log("  valoreRiferimento:", trattativa.valoreRiferimento);
  console.log("  mittente:", trattativa.fantaTeamMittente.nome);
  console.log("  ricevente:", trattativa.fantaTeamRicevente.nome);

  const dataDecorrenza = trattativa.dataDecorrenza;
  const anniContratto  = trattativa.anniContrattoProposti;
  const categoria      = trattativa.categoriaProposta;
  const importo        = Number(trattativa.importoOfferta);

  console.log("\n--- Calcolo immediato ---");
  const immediato = !dataDecorrenza || isDecorrenzaImmediata(dataDecorrenza);
  console.log("immediato:", immediato);

  if (!immediato) {
    const [mm, yyyy] = (dataDecorrenza || "").split("-").map(Number);
    console.log("mm:", mm, "yyyy:", yyyy);
    const dataFine = `${yyyy + anniContratto}-06-30`;
    console.log("dataFine:", dataFine);
    const dataStipula = dataDecorrenza;
    console.log("dataStipula:", dataStipula);
  }

  const params = await parametriService.getAll();
  console.log("\n--- Provo a eseguire il trasferimento (DRY RUN senza transazione) ---");

  try {
    // Prova a creare il contratto dentro una transazione che poi facciamo rollback
    await prisma.$transaction(async (tx) => {
      const ultimaQuotDef = await tx.quotazione.findFirst({
        where:   { giocatoreId: trattativa.giocatoreId },
        orderBy: { createdAt: "desc" },
      });
      console.log("ultimaQuotDef:", ultimaQuotDef ? `valore=${ultimaQuotDef.valore}` : "null");

      const quotValDef      = ultimaQuotDef?.valore ? Number(ultimaQuotDef.valore) : Number(trattativa.valoreRiferimento);
      const estivoDef       = isDecorrenzaEstiva(dataDecorrenza);
      const stipendioPctDef = estivoDef
        ? parseFloat(params.stipendio_percentuale || "0.10")
        : parseFloat(params.stipendio_percentuale_invernale || "0.05");
      const stipendioNuovoDef = calcolaStipendio(quotValDef, stipendioPctDef);
      console.log("quotValDef:", quotValDef, "estivoDef:", estivoDef, "stipendioNuovoDef:", stipendioNuovoDef);

      const [mm, yyyy] = (dataDecorrenza || "").split("-").map(Number);
      const dataFine    = new Date(Date.UTC(yyyy + anniContratto, 5, 30, 12, 0, 0));
      const dataStipula = dataDecorrenza;
      console.log("dataStipula:", dataStipula, "dataFine:", dataFine);

      const nuovoContratto = await tx.contratto.create({
        data: {
          tipo:              trattativa.tipoContratto || "Acquisto",
          clausola:          trattativa.clausola || null,
          dataStipula,
          durataContratto:   anniContratto,
          dataFine,
          giocatoreId:       trattativa.giocatoreId,
          fantaTeamId:       trattativa.fantaTeamMittenteId,
          valoreGiocatore:   trattativa.valoreRiferimento,
          prezzoAcquisto:    importo,
          importoOperazione: stipendioNuovoDef,
          provenienza:       trattativa.fantaTeamRicevente.nome,
          destinazione:      trattativa.fantaTeamMittente.nome,
          valido:            false,
        },
      });
      console.log("Contratto creato (id:", nuovoContratto.id, ") — dataStipula:", nuovoContratto.dataStipula, "dataFine:", nuovoContratto.dataFine);

      await tx.trattativaMercato.update({
        where: { id: trattativa.id },
        data:  { stato: "COMPLETED_DEFERRED", contrattoNuovoId: nuovoContratto.id },
      });
      console.log("Trattativa aggiornata a COMPLETED_DEFERRED");

      // Rollback intenzionale per non modificare il DB
      throw new Error("__ROLLBACK_INTENZIONALE__");
    });
  } catch (err) {
    if (err.message === "__ROLLBACK_INTENZIONALE__") {
      console.log("\n✅ DRY RUN completato senza errori! Rollback intenzionale eseguito.");
      console.log("→ L'accettazione funzionerebbe correttamente.");
    } else {
      console.error("\n❌ ERRORE REALE durante l'esecuzione:");
      console.error("   Tipo:", err.constructor.name);
      console.error("   Messaggio:", err.message);
      if (err.code) console.error("   Code:", err.code);
      if (err.meta) console.error("   Meta:", JSON.stringify(err.meta));
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
