/**
 * scripts/svincola-zero-anni-non-in-rosa.js
 *
 * Applica la regola:
 *   "I giocatori a 0 anni di contratto e NON inseriti nelle proposte di rinnovo
 *    vanno svincolati. Il presidente proprietario recupera il valore
 *    dell'ultima quotazione."
 *
 * Casistica gestita qui: contratti che NON hanno una RosaGiocatore stagione
 * corrente (i contratti "in rosa" sono già coperti da fine-stagione /
 * svincola-scaduti-non-svincolati.js).
 *
 * Effetti per ciascun contratto:
 *   - contratto.valido = false, destinazione = "Scaduto"  (preserva pre)
 *   - SF.crediti += quotazione (ultima transfermarkt, fallback giocatore.valore)
 *   - NON modifica valoreRose / stipendi / giocatoriTesserati (non era in rosa)
 *
 * Uso:
 *   node scripts/svincola-zero-anni-non-in-rosa.js              → dry-run
 *   node scripts/svincola-zero-anni-non-in-rosa.js --execute    → applica
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { getRemainingContractYears } = require('../src/utils/contractUtils');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const STAGIONE_OLD = '2025-2026';
const STAGIONE_NEW = '2026-2027';
const ADMIN_ID = 2;
const DRY_RUN = !process.argv.includes('--execute');

function log(m) { console.log(`[svincola-0anni] ${m}`); }

async function ultimaQuotazione(client, giocatoreId, fallback) {
  const q = await client.quotazione.findFirst({
    where: { giocatoreId, fonte: 'transfermarkt' },
    orderBy: { createdAt: 'desc' },
    select: { valore: true },
  });
  if (q && q.valore != null) return Number(q.valore);
  return fallback != null ? Number(fallback) : 0;
}

async function main() {
  log(`Modalità: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  // 1. Contratti validi con 0 anni residui
  const tutti = await prisma.contratto.findMany({
    where: { valido: true },
    include: { giocatore: true, fantaTeam: { include: { user: true } } },
  });
  const zeroAnni = tutti.filter(c => getRemainingContractYears(c.dataFine) === 0);

  // 2. Esclude quelli con proposta di rinnovo per nuova stagione
  const proposte = await prisma.propostaRinnovo.findMany({
    where: { contrattoId: { in: zeroAnni.map(c => c.id) }, stagione: STAGIONE_NEW },
    select: { contrattoId: true },
  });
  const conProposta = new Set(proposte.map(x => x.contrattoId));
  const senzaProposta = zeroAnni.filter(c => !conProposta.has(c.id));

  // 3. Esclude quelli già in rosa (gestiti altrove)
  const rosaCorrente = await prisma.rosaGiocatore.findMany({
    where: {
      stagione: STAGIONE_OLD,
      giocatoreId: { in: senzaProposta.map(c => c.giocatoreId) },
      fantaTeamId: { in: senzaProposta.map(c => c.fantaTeamId) },
    },
    select: { fantaTeamId: true, giocatoreId: true },
  });
  const inRosa = new Set(rosaCorrente.map(r => `${r.fantaTeamId}:${r.giocatoreId}`));
  const candidati = senzaProposta.filter(c => !inRosa.has(`${c.fantaTeamId}:${c.giocatoreId}`));

  log(`Candidati (0 anni, no rinnovo, NON in rosa): ${candidati.length}\n`);
  if (!candidati.length) {
    log('Niente da fare.');
    await prisma.$disconnect();
    return;
  }

  // 4. Pre-calcola piano
  const plan = [];
  for (const c of candidati) {
    const quot = await ultimaQuotazione(prisma, c.giocatoreId, c.giocatore?.valore);
    const presNome = c.fantaTeam.user ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email) : null;
    let sf = await prisma.situazioneFinanziaria.findFirst({
      where: { fantaTeamId: c.fantaTeamId, stagione: STAGIONE_OLD },
    });
    if (!sf && presNome) {
      sf = await prisma.situazioneFinanziaria.findFirst({
        where: { nomePresidente: presNome, stagione: STAGIONE_OLD },
      });
    }
    plan.push({
      contrattoId: c.id,
      giocatoreId: c.giocatoreId,
      giocatoreNome: c.giocatore.nome,
      fantaTeamId: c.fantaTeamId,
      teamNome: c.fantaTeam.nome,
      tipo: c.tipo,
      destinazionePre: c.destinazione,
      stipendio: c.importoOperazione ? Number(c.importoOperazione) : 0,
      quotValore: quot,
      sf,
    });
  }

  // 5. Stampa piano (con delta cumulati per SF)
  log('Piano (delta cumulati per SF):');
  const sfState = new Map();
  for (const p of plan) {
    if (!p.sf) continue;
    if (!sfState.has(p.sf.id)) sfState.set(p.sf.id, { crediti: Number(p.sf.crediti) });
  }
  for (const p of plan) {
    if (!p.sf) {
      console.log(`  c#${p.contrattoId} | ${p.giocatoreNome.padEnd(25)} | ${p.teamNome.padEnd(20)} | SF NON TROVATA, skip accredito`);
      continue;
    }
    const s = sfState.get(p.sf.id);
    const pre = s.crediti;
    s.crediti = Math.round((pre + p.quotValore) * 100) / 100;
    console.log(
      `  c#${p.contrattoId} | ${p.giocatoreNome.padEnd(25)} | ${p.teamNome.padEnd(20)} | ` +
      `quot=${p.quotValore.toFixed(2)} | SF#${p.sf.id} crediti ${pre.toFixed(2)}→${s.crediti.toFixed(2)}`
    );
  }

  if (DRY_RUN) {
    log('\nDRY-RUN: nessuna modifica. Rilancia con --execute per applicare.');
    await prisma.$disconnect();
    return;
  }

  // 6. Esegui
  log('\nEsecuzione in transazione...');
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const c = await tx.contratto.findUnique({ where: { id: p.contrattoId } });
      const preContratto = {
        valido: true, destinazione: c.destinazione,
        tipo: c.tipo, durataContratto: c.durataContratto,
        giocatoreId: c.giocatoreId, fantaTeamId: c.fantaTeamId,
      };

      await tx.contratto.update({
        where: { id: c.id },
        data: { valido: false, destinazione: 'Scaduto' },
      });

      await tx.log.create({
        data: {
          azione: 'UPDATE', entita: 'contratto', entitaId: c.id,
          dettaglio: JSON.stringify({
            tipo: 'svincolo-zero-anni-non-in-rosa',
            motivo: 'contratto 0 anni residui, non in rinnovi, giocatore non in rosa',
            pre: preContratto,
            post: { valido: false, destinazione: 'Scaduto' },
          }),
          adminId: ADMIN_ID,
        },
      });

      if (p.sf && p.quotValore > 0) {
        const sfFresh = await tx.situazioneFinanziaria.findUnique({ where: { id: p.sf.id } });
        const pre = { crediti: Number(sfFresh.crediti) };
        const post = { crediti: Math.round((pre.crediti + p.quotValore) * 100) / 100 };
        await tx.situazioneFinanziaria.update({ where: { id: p.sf.id }, data: post });
        await tx.log.create({
          data: {
            azione: 'UPDATE', entita: 'situazione_finanziaria', entitaId: p.sf.id,
            dettaglio: JSON.stringify({
              tipo: 'svincolo-zero-anni-non-in-rosa',
              contrattoId: c.id, giocatoreId: p.giocatoreId, giocatoreNome: p.giocatoreNome,
              fantaTeamId: p.fantaTeamId, quotazioneAccredito: p.quotValore,
              motivo: 'accredito valore ultima quotazione',
              pre, post,
            }),
            adminId: ADMIN_ID,
          },
        });
      }
    }
  });

  log(`Completato: ${plan.length} contratti svincolati.`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
