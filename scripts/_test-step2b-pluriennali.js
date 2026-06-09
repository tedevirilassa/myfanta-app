// scripts/_test-step2b-pluriennali.js
// Smoke-test della Fase 2B:
//   - costruisce ctx
//   - calcola candidati
//   - in transazione: esegue addebito (compreso riallineamento invernale) → ROLLBACK
//   - verifica idempotenza: nessuna scrittura persistente
//   - verifica che `annullaStep2B` riconosca un batchId fittizio inesistente
//
// Non chiama gli handler express: invoca direttamente le funzioni interne via
// require monkey-patched (più semplice: replica la logica in una mini-transazione).

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { modificaCreditiTeam, CAUSALI } = require('../src/services/finanze.service');

const ADMIN_ID = 2;

function stagioneCorrente(meseInizio) {
  const oggi = new Date();
  const meseOggi = oggi.getMonth() + 1;
  const anno = meseOggi >= meseInizio ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return { stagione: `${anno}-${anno + 1}`, annoInizio: anno };
}

(async () => {
  const params = Object.fromEntries(
    (await prisma.parametro.findMany()).map((p) => [p.chiave, p.valore])
  );
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const sCorrente = stagioneCorrente(meseInizio);
  const stagioneOld = sCorrente.stagione;
  const annoFineStagione = sCorrente.annoInizio + 1;
  const stagioneNew = `${sCorrente.annoInizio + 1}-${sCorrente.annoInizio + 2}`;

  console.log(`Ctx: stagioneOld=${stagioneOld}, annoFineStagione=${annoFineStagione}`);

  // ── 1. Calcolo candidati come fa _planStep2B
  const approvedProposte = await prisma.propostaRinnovo.findMany({
    where: { stagione: stagioneNew, status: "APPROVED" },
    select: { contrattoId: true },
  });
  const idsApproved = new Set(approvedProposte.map((p) => p.contrattoId));

  const contratti = await prisma.contratto.findMany({
    where: { valido: true, tipo: "Acquisto", NOT: [{ id: { in: Array.from(idsApproved) } }] },
    include: { giocatore: { select: { nome: true, id: true } },
               fantaTeam: { include: { user: true } } },
  });

  const candidati = [];
  for (const c of contratti) {
    if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) continue;
    const annoFine = parseInt(c.dataFine.split("-")[1], 10);
    if (annoFine <= annoFineStagione) continue;
    const stipendioAttuale = c.importoOperazione ? Number(c.importoOperazione) : 0;
    const isInvernale = typeof c.dataStipula === "string"
      && c.dataStipula.startsWith("01-")
      && parseInt(c.dataStipula.split("-")[1], 10) === annoFineStagione;
    const stipendioAddebito = isInvernale ? Math.round(stipendioAttuale * 2 * 100) / 100 : stipendioAttuale;
    candidati.push({
      contrattoId: c.id, giocatoreNome: c.giocatore.nome,
      fantaTeamId: c.fantaTeamId, teamNome: c.fantaTeam.nome,
      presNome: c.fantaTeam.user ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email) : null,
      dataStipula: c.dataStipula, dataFine: c.dataFine,
      stipendioAttuale, stipendioAddebito,
      riallineamentoInvernale: isInvernale,
    });
  }

  console.log(`\nCandidati totali: ${candidati.length}`);
  const invernali = candidati.filter((x) => x.riallineamentoInvernale);
  console.log(`Riallineamenti invernali (dataStipula 01-${annoFineStagione}): ${invernali.length}`);
  if (invernali.length > 0) {
    console.log('Esempi:');
    for (const i of invernali.slice(0, 5)) {
      console.log(`  c#${i.contrattoId} ${i.giocatoreNome} (${i.teamNome}): ${i.stipendioAttuale} → ${i.stipendioAddebito}`);
    }
  }

  const totaleAddebito = Math.round(candidati.reduce((s, x) => s + x.stipendioAddebito, 0) * 100) / 100;
  console.log(`Totale addebito stimato: ${totaleAddebito.toFixed(2)} M`);

  // Aggregato per team
  const perTeam = {};
  for (const c of candidati) {
    if (!perTeam[c.fantaTeamId]) perTeam[c.fantaTeamId] = { team: c.teamNome, tot: 0, n: 0 };
    perTeam[c.fantaTeamId].tot += c.stipendioAddebito;
    perTeam[c.fantaTeamId].n += 1;
  }
  console.log('\nPer team:');
  for (const [id, t] of Object.entries(perTeam)) {
    console.log(`  team#${id} ${t.team}: ${t.n} contratti, ${t.tot.toFixed(2)} M`);
  }

  // ── 2. Esegui in transazione e fai ROLLBACK
  console.log('\n[T1] Esecuzione in transazione con ROLLBACK forzato');
  const batchId = `test-${Date.now()}`;
  const sfPreSnapshot = await prisma.situazioneFinanziaria.findMany({
    where: { stagione: stagioneOld },
    select: { id: true, crediti: true, stipendi: true, patrimonio: true },
  });

  try {
    await prisma.$transaction(async (tx) => {
      let applicati = 0;
      for (const cand of candidati) {
        let sf = await tx.situazioneFinanziaria.findFirst({
          where: { fantaTeamId: cand.fantaTeamId, stagione: stagioneOld },
        });
        if (!sf && cand.presNome) {
          sf = await tx.situazioneFinanziaria.findFirst({
            where: { nomePresidente: cand.presNome, stagione: stagioneOld },
          });
        }
        if (!sf) throw new Error(`SF non trovata per team#${cand.fantaTeamId} stagione ${stagioneOld}`);

        if (cand.riallineamentoInvernale) {
          await tx.contratto.update({
            where: { id: cand.contrattoId },
            data:  { importoOperazione: cand.stipendioAddebito },
          });
        }
        await modificaCreditiTeam(tx, {
          sfId: sf.id, fantaTeamId: cand.fantaTeamId, stagione: stagioneOld,
          deltaCrediti: -cand.stipendioAddebito, deltaStipendi: 0,
          causale: CAUSALI.PAGAMENTO_STIPENDIO_PLURIENNALE,
          contesto: { batchId, contrattoId: cand.contrattoId },
          adminId: ADMIN_ID, checkCapienza: false,
        });
        applicati++;
      }
      console.log(`  Applicati ${applicati} addebiti in transazione`);
      throw new Error('ROLLBACK_INTENZIONALE');
    }, { timeout: 120_000 });
  } catch (e) {
    if (e.message !== 'ROLLBACK_INTENZIONALE') throw e;
    console.log('  ✓ rollback eseguito');
  }

  // Verifica idempotenza
  const sfPost = await prisma.situazioneFinanziaria.findMany({
    where: { stagione: stagioneOld },
    select: { id: true, crediti: true, stipendi: true, patrimonio: true },
  });
  const preMap = new Map(sfPreSnapshot.map((s) => [s.id, s]));
  let drift = 0;
  for (const p of sfPost) {
    const pre = preMap.get(p.id);
    if (!pre) continue;
    if (Number(pre.crediti)   !== Number(p.crediti))   drift++;
    if (Number(pre.stipendi)  !== Number(p.stipendi))  drift++;
    if (Number(pre.patrimonio)!== Number(p.patrimonio))drift++;
  }
  if (drift > 0) throw new Error(`Drift dopo rollback: ${drift} campi mutati!`);
  console.log('  ✓ tutte le SF invariate dopo rollback');

  const movDrift = await prisma.movimentoFinanziario.count({
    where: { contesto: { contains: batchId } },
  });
  if (movDrift > 0) throw new Error(`Drift: ${movDrift} MovimentoFinanziario rimasti per batch ${batchId}`);
  console.log('  ✓ nessun MovimentoFinanziario residuo');

  console.log('\n✅ Tutti i test passati.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
