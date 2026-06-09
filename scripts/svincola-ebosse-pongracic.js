/**
 * scripts/svincola-ebosse-pongracic.js
 *
 * Caso speciale: dataFine errata 07-2027 → la correggiamo a 07-2026 prima di svincolare.
 *
 * Ebosse  (gioc #664, c#437): NON in rosa → solo crediti += 2.80
 * Pongracic (gioc #543, c#433): InRosa Giannik → crediti +=6.50, valoreRose -=6.50,
 *                                                 gioc -=1, stipendi -=0, remove rosa
 *
 * Uso: node scripts/svincola-ebosse-pongracic.js [--execute]
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const STAGIONE_OLD = '2025-2026';
const SF_ID = 8;          // Giannik
const FANTATEAM_ID = 9;   // Giannik
const ADMIN_ID = 2;
const DRY_RUN = !process.argv.includes('--execute');

const targets = [
  { contrattoId: 437, giocatoreId: 664, giocatoreNome: 'Enzo Ebosse',     quotValore: 2.8,  inRosa: false },
  { contrattoId: 433, giocatoreId: 543, giocatoreNome: 'Marin Pongracic', quotValore: 6.5,  inRosa: true  },
];

(async () => {
  console.log(`[svincola-ep] Modalità: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}\n`);

  // Stato iniziale
  const sfPre = await prisma.situazioneFinanziaria.findUnique({ where: { id: SF_ID } });
  let crediti = Number(sfPre.crediti);
  let valoreRose = Number(sfPre.valoreRose);
  let gioc = sfPre.giocatoriTesserati;
  let stipendi = Number(sfPre.stipendi);

  console.log(`SF#${SF_ID} pre:  crediti=${crediti} valR=${valoreRose} stip=${stipendi} gioc=${gioc}`);

  const plan = [];
  for (const t of targets) {
    const c = await prisma.contratto.findUnique({ where: { id: t.contrattoId } });
    const pre = { crediti, valoreRose, gioc, stipendi };
    crediti = Math.round((crediti + t.quotValore) * 100) / 100;
    if (t.inRosa) {
      valoreRose = Math.round((valoreRose - t.quotValore) * 100) / 100;
      gioc = Math.max(0, gioc - 1);
      const stipDelta = c.importoOperazione ? Number(c.importoOperazione) : 0;
      stipendi = Math.round((stipendi - stipDelta) * 100) / 100;
    }
    const post = { crediti, valoreRose, gioc, stipendi };
    console.log(`  ${t.giocatoreNome.padEnd(20)} | dataFine ${c.dataFine}→07-2026 valido true→false`);
    console.log(`     SF: crediti ${pre.crediti}→${post.crediti}, valR ${pre.valoreRose}→${post.valoreRose}, stip ${pre.stipendi}→${post.stipendi}, gioc ${pre.gioc}→${post.gioc}`);
    plan.push({ t, c, pre, post });
  }
  console.log(`\nSF#${SF_ID} post: crediti=${crediti} valR=${valoreRose} stip=${stipendi} gioc=${gioc}`);

  if (DRY_RUN) {
    console.log('\nDRY-RUN. Rilancia con --execute per applicare.');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const { t, c } of plan) {
      const preContratto = {
        valido: c.valido, dataFine: c.dataFine, durataContratto: c.durataContratto,
        destinazione: c.destinazione, tipo: c.tipo,
        importoOperazione: c.importoOperazione ? Number(c.importoOperazione) : 0,
      };

      // Step 1: correggi dataFine + invalida
      await tx.contratto.update({
        where: { id: c.id },
        data: { dataFine: '07-2026', valido: false, destinazione: c.destinazione || 'Scaduto' },
      });
      await tx.log.create({
        data: {
          azione: 'UPDATE', entita: 'contratto', entitaId: c.id,
          dettaglio: JSON.stringify({
            tipo: 'svincolo-manuale-correzione-datafine',
            motivo: 'dataFine errata 07-2027 corretta a 07-2026 + svincolo per scadenza naturale (non rinnovato)',
            pre: preContratto,
            post: { valido: false, dataFine: '07-2026', destinazione: c.destinazione || 'Scaduto' },
          }),
          adminId: ADMIN_ID,
        },
      });

      // Step 2: SF — rileggi fresca per ogni iterazione
      const sfFresh = await tx.situazioneFinanziaria.findUnique({ where: { id: SF_ID } });
      const pre = {
        crediti: Number(sfFresh.crediti),
        valoreRose: Number(sfFresh.valoreRose),
        giocatoriTesserati: sfFresh.giocatoriTesserati,
        stipendi: Number(sfFresh.stipendi),
      };
      const post = {
        crediti:            Math.round((pre.crediti + t.quotValore) * 100) / 100,
        valoreRose:         t.inRosa ? Math.round((pre.valoreRose - t.quotValore) * 100) / 100 : pre.valoreRose,
        giocatoriTesserati: t.inRosa ? Math.max(0, pre.giocatoriTesserati - 1) : pre.giocatoriTesserati,
        stipendi:           t.inRosa ? Math.round((pre.stipendi - (c.importoOperazione ? Number(c.importoOperazione) : 0)) * 100) / 100 : pre.stipendi,
      };
      await tx.situazioneFinanziaria.update({ where: { id: SF_ID }, data: post });
      await tx.log.create({
        data: {
          azione: 'UPDATE', entita: 'situazione_finanziaria', entitaId: SF_ID,
          dettaglio: JSON.stringify({
            tipo: 'svincolo-manuale-correzione-datafine',
            contrattoId: c.id, giocatoreId: t.giocatoreId, giocatoreNome: t.giocatoreNome,
            fantaTeamId: FANTATEAM_ID, quotazioneAccredito: t.quotValore,
            motivo: t.inRosa ? 'svincolo con storno rosa' : 'svincolo senza rosa (solo accredito crediti)',
            pre, post,
          }),
          adminId: ADMIN_ID,
        },
      });

      // Step 3: rimuovi rosa
      if (t.inRosa) {
        await tx.rosaGiocatore.deleteMany({
          where: { fantaTeamId: FANTATEAM_ID, giocatoreId: t.giocatoreId, stagione: STAGIONE_OLD },
        });
      }
    }
  });

  console.log('\n[svincola-ep] Completato.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
