/**
 * scripts/rollback-svincoli-anomali.js
 *
 * Annulla i 25 svincoli applicati erroneamente dalla run di fine stagione
 * eseguita il 2026-06-04 ~15:06 UTC su contratti con dataFine futura (07-2027)
 * ma durataContratto=0.
 *
 * Per ogni contratto svincolato erroneamente:
 *   - Ripristina valido=true e durataContratto=1 (post-decrement corretto)
 *   - Inverte le variazioni di SituazioneFinanziaria (delta dal log)
 *   - Ricrea la riga RosaGiocatore stagione 2025-2026 (categoria InRosa)
 *   - Marca i log relativi come rollbacked=true
 *
 * Uso:
 *   node scripts/rollback-svincoli-anomali.js              → dry-run (default)
 *   node scripts/rollback-svincoli-anomali.js --execute    → applica modifiche
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const WINDOW_START = new Date('2026-06-04T15:05:00.000Z');
const WINDOW_END   = new Date('2026-06-04T15:07:00.000Z');
const ANNO_FINE_STAGIONE = 2026; // stagione 2025-2026
const STAGIONE_OLD = '2025-2026';
const CATEGORIA_DEFAULT = 'InRosa';

const DRY_RUN = !process.argv.includes('--execute');

function log(msg) { console.log(`[rollback] ${msg}`); }

async function main() {
  log(`Modalità: ${DRY_RUN ? 'DRY-RUN (nessuna modifica)' : 'EXECUTE'}`);

  // 1. Identifica i contratti svincolati erroneamente
  const candidates = await prisma.contratto.findMany({
    where: {
      valido: false,
      updatedAt: { gte: WINDOW_START, lte: WINDOW_END },
    },
    include: { giocatore: true, fantaTeam: true },
    orderBy: { id: 'asc' },
  });

  const targets = candidates.filter((c) => {
    if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) return false;
    const annoFine = parseInt(c.dataFine.split('-')[1], 10);
    return annoFine > ANNO_FINE_STAGIONE;
  });

  log(`Contratti svincolati in finestra: ${candidates.length}`);
  log(`Da ripristinare (dataFine futura > ${ANNO_FINE_STAGIONE}): ${targets.length}`);

  if (targets.length === 0) {
    log('Niente da fare.');
    return;
  }

  // 2. Recupera i log della run
  const logsRun = await prisma.log.findMany({
    where: {
      entita: { in: ['contratto', 'situazione_finanziaria'] },
      createdAt: { gte: WINDOW_START, lte: WINDOW_END },
    },
    orderBy: { createdAt: 'asc' },
  });

  const logsSfByContractId = new Map();
  const logsContrattoByContractId = new Map();
  for (const l of logsRun) {
    let det;
    try { det = typeof l.dettaglio === 'string' ? JSON.parse(l.dettaglio) : l.dettaglio; }
    catch { continue; }
    if (l.entita === 'contratto') {
      logsContrattoByContractId.set(l.entitaId, l);
    } else if (l.entita === 'situazione_finanziaria' && det.contrattoId) {
      logsSfByContractId.set(det.contrattoId, l);
    }
  }

  // 3. Costruisci piano di rollback
  const plan = [];
  for (const c of targets) {
    const logSf = logsSfByContractId.get(c.id) || null;
    const logCt = logsContrattoByContractId.get(c.id) || null;
    let sfDelta = null;
    if (logSf) {
      const det = JSON.parse(logSf.dettaglio);
      sfDelta = {
        sfId: logSf.entitaId,
        // delta da APPLICARE per invertire l'effetto: post-svincolo - pre-svincolo, negato
        deltaCrediti:           Number(det.pre.crediti)    - Number(det.post.crediti),
        deltaValoreRose:        Number(det.pre.valoreRose) - Number(det.post.valoreRose),
        deltaStipendi:          Number(det.pre.stipendi)   - Number(det.post.stipendi),
        deltaGiocatoriTesserati: det.pre.giocatoriTesserati - det.post.giocatoriTesserati,
        giocatoreNome: det.giocatoreNome,
        logSfId: logSf.id,
      };
    }
    plan.push({
      contrattoId: c.id,
      giocatoreNome: c.giocatore?.nome,
      teamNome: c.fantaTeam?.nome,
      fantaTeamId: c.fantaTeamId,
      giocatoreId: c.giocatoreId,
      sfDelta,
      logContrattoId: logCt?.id || null,
      dataFine: c.dataFine,
      dataStipula: c.dataStipula,
      durataContrattoAttuale: c.durataContratto,
    });
  }

  log('\nPiano di rollback:');
  for (const p of plan) {
    console.log(
      `  contratto ${p.contrattoId} | ${p.giocatoreNome.padEnd(25)} | ${p.teamNome.padEnd(20)} | ` +
      `dataFine=${p.dataFine} | durata: ${p.durataContrattoAttuale} → 1 | ` +
      (p.sfDelta
        ? `SF#${p.sfDelta.sfId}: crediti${p.sfDelta.deltaCrediti>=0?'+':''}${p.sfDelta.deltaCrediti}, ` +
          `valoreRose${p.sfDelta.deltaValoreRose>=0?'+':''}${p.sfDelta.deltaValoreRose}, ` +
          `stipendi${p.sfDelta.deltaStipendi>=0?'+':''}${p.sfDelta.deltaStipendi}, ` +
          `gioc${p.sfDelta.deltaGiocatoriTesserati>=0?'+':''}${p.sfDelta.deltaGiocatoriTesserati}`
        : 'SF: nessun log')
    );
  }

  if (DRY_RUN) {
    log('\nDRY-RUN: nessuna modifica applicata. Rilancia con --execute per applicare.');
    return;
  }

  // 4. Esegui rollback in transazione
  log('\nEsecuzione rollback in transazione...');
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      // 4a. Ripristina contratto
      await tx.contratto.update({
        where: { id: p.contrattoId },
        data: { valido: true, durataContratto: 1 },
      });

      // 4b. Inverti SF (applico delta letti dal log)
      if (p.sfDelta) {
        const sf = await tx.situazioneFinanziaria.findUnique({ where: { id: p.sfDelta.sfId } });
        if (sf) {
          const newCrediti    = Math.round((Number(sf.crediti)    + p.sfDelta.deltaCrediti)    * 100) / 100;
          const newValoreRose = Math.round((Number(sf.valoreRose) + p.sfDelta.deltaValoreRose) * 100) / 100;
          const newStipendi   = Math.round((Number(sf.stipendi)   + p.sfDelta.deltaStipendi)   * 100) / 100;
          const newGioc       = sf.giocatoriTesserati + p.sfDelta.deltaGiocatoriTesserati;
          await tx.situazioneFinanziaria.update({
            where: { id: p.sfDelta.sfId },
            data: {
              crediti: newCrediti,
              valoreRose: newValoreRose,
              stipendi: newStipendi,
              giocatoriTesserati: newGioc,
            },
          });
        }
      }

      // 4c. Ricrea RosaGiocatore (stagione 2025-2026) se non esiste
      const existing = await tx.rosaGiocatore.findFirst({
        where: {
          fantaTeamId: p.fantaTeamId,
          giocatoreId: p.giocatoreId,
          stagione: STAGIONE_OLD,
        },
      });
      if (!existing) {
        await tx.rosaGiocatore.create({
          data: {
            fantaTeamId: p.fantaTeamId,
            giocatoreId: p.giocatoreId,
            stagione: STAGIONE_OLD,
            categoria: CATEGORIA_DEFAULT,
          },
        });
      }

      // 4d. Marca i log come rollbacked
      const logIdsToMark = [p.logContrattoId, p.sfDelta?.logSfId].filter(Boolean);
      if (logIdsToMark.length) {
        await tx.log.updateMany({
          where: { id: { in: logIdsToMark } },
          data: { rollbacked: true },
        });
      }

      // 4e. Log azione di rollback
      await tx.log.create({
        data: {
          azione: 'ROLLBACK',
          entita: 'contratto',
          entitaId: p.contrattoId,
          dettaglio: JSON.stringify({
            tipo: 'rollback-svincolo-anomalo',
            motivo: 'dataFine futura, svincolato per bug durataContratto<=0',
            giocatore: p.giocatoreNome,
            team: p.teamNome,
            ripristino: { valido: true, durataContratto: 1 },
            sfDeltaApplicato: p.sfDelta,
          }),
          adminId: 2,
        },
      });
    }
  });

  log(`Rollback completato: ${plan.length} contratti ripristinati.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
