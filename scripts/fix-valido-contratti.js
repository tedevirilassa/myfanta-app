/**
 * Per ogni giocatore:
 * - L'ultimo contratto di Acquisto (per dataStipula) è valido
 * - L'ultimo contratto di Prestito è anch'esso valido, a patto che il prestante
 *   (fantaTeamId dell'Acquisto valido) sia il proprietario del giocatore
 * - Tutti gli altri contratti → scaduto
 */
require("dotenv").config();
const prisma = require("../src/lib/prisma");

async function main() {
  // Prima: segna tutti come scaduti
  await prisma.contratto.updateMany({ data: { valido: false } });

  // Carica tutti i contratti ordinati per giocatore e data decrescente
  const contratti = await prisma.contratto.findMany({
    orderBy: [{ giocatoreId: "asc" }, { dataStipula: "desc" }, { id: "desc" }],
  });

  // Raggruppa per giocatoreId
  const byGiocatore = {};
  for (const c of contratti) {
    if (!byGiocatore[c.giocatoreId]) byGiocatore[c.giocatoreId] = [];
    byGiocatore[c.giocatoreId].push(c);
  }

  const validIds = [];

  for (const gId of Object.keys(byGiocatore)) {
    const lista = byGiocatore[gId];

    // Trova l'ultimo Acquisto
    const ultimoAcquisto = lista.find(c => c.tipo === "Acquisto");
    if (ultimoAcquisto) {
      validIds.push(ultimoAcquisto.id);

      // Trova l'ultimo Prestito il cui fantaTeamId != proprietario (prestante = proprietario)
      const ultimoPrestito = lista.find(c => c.tipo === "Prestito");
      if (ultimoPrestito && ultimoPrestito.fantaTeamId !== ultimoAcquisto.fantaTeamId) {
        // Il prestito è verso un altro team, il prestante è il proprietario → valido
        validIds.push(ultimoPrestito.id);
      }
    } else {
      // Nessun acquisto: il più recente qualsiasi è valido
      if (lista.length > 0) validIds.push(lista[0].id);
    }
  }

  // Segna come validi
  if (validIds.length > 0) {
    await prisma.contratto.updateMany({
      where: { id: { in: validIds } },
      data: { valido: true },
    });
  }

  console.log(`Done: ${validIds.length} contratti marcati come Valido, il resto come Scaduto.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
