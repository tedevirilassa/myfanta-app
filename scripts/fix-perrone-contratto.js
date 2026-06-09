/**
 * scripts/fix-perrone-contratto.js
 *
 * Ripristina Maximo Perrone (contratto #498):
 *   - dataFine corretta: 07-2027 (era stata erroneamente messa a 07-2026 il 04-06)
 *   - contratto.valido = true, destinazione = "Valentino"
 *   - durataContratto = 1
 *   - Riga RosaGiocatore 2025-2026 categoria "InRosa" (Parkinglover)
 *   - Storno SF Parkinglover 2025-2026: inverte il log#1177 originale
 *     (crediti -35, valoreRose +35, giocatoriTesserati +1)
 *
 * Uso: node scripts/fix-perrone-contratto.js [--execute]
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const CONTRATTO_ID = 498;
const SF_ID = 10;
const GIOCATORE_ID = 232;
const FANTATEAM_ID = 11;
const STAGIONE_OLD = '2025-2026';
const QUOT_VALORE = 35; // come da log originale #1177
const ADMIN_ID = 2;
const DRY_RUN = !process.argv.includes('--execute');

(async () => {
  console.log(`[fix-perrone] Modalità: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  const c = await prisma.contratto.findUnique({
    where: { id: CONTRATTO_ID },
    include: { giocatore: true, fantaTeam: true },
  });
  const sf = await prisma.situazioneFinanziaria.findUnique({ where: { id: SF_ID } });

  console.log(`\nContratto pre: valido=${c.valido} dataFine=${c.dataFine} dur=${c.durataContratto} dest=${c.destinazione}`);
  console.log(`SF pre:        crediti=${sf.crediti} valR=${sf.valoreRose} stip=${sf.stipendi} gioc=${sf.giocatoriTesserati}`);

  const contrattoPost = {
    valido: true,
    dataFine: '07-2027',
    durataContratto: 1,
    destinazione: 'Valentino',
  };
  const sfPre = {
    crediti: Number(sf.crediti),
    valoreRose: Number(sf.valoreRose),
    giocatoriTesserati: sf.giocatoriTesserati,
    stipendi: Number(sf.stipendi),
  };
  const sfPost = {
    crediti:            Math.round((sfPre.crediti    - QUOT_VALORE) * 100) / 100,
    valoreRose:         Math.round((sfPre.valoreRose + QUOT_VALORE) * 100) / 100,
    giocatoriTesserati: sfPre.giocatoriTesserati + 1,
    stipendi:           sfPre.stipendi, // invariato (importoOperazione era 0)
  };

  console.log(`\nContratto post: valido=true dataFine=07-2027 dur=1 dest=Valentino`);
  console.log(`SF post:        crediti=${sfPost.crediti} valR=${sfPost.valoreRose} stip=${sfPost.stipendi} gioc=${sfPost.giocatoriTesserati}`);
  console.log(`RosaGiocatore:  +1 riga (team=${FANTATEAM_ID}, gioc=${GIOCATORE_ID}, stagione=${STAGIONE_OLD}, categoria=InRosa)`);

  if (DRY_RUN) {
    console.log('\nDRY-RUN. Rilancia con --execute per applicare.');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    const preContratto = {
      valido: c.valido, dataFine: c.dataFine, durataContratto: c.durataContratto,
      destinazione: c.destinazione,
    };
    await tx.contratto.update({ where: { id: c.id }, data: contrattoPost });
    await tx.log.create({
      data: {
        azione: 'UPDATE', entita: 'contratto', entitaId: c.id,
        dettaglio: JSON.stringify({
          tipo: 'fix-manuale-perrone',
          motivo: 'dataFine corretta a 07-2027, ripristino contratto post-svincolo erroneo del 04-06',
          pre: preContratto, post: contrattoPost,
        }),
        adminId: ADMIN_ID,
      },
    });

    await tx.situazioneFinanziaria.update({ where: { id: SF_ID }, data: sfPost });
    await tx.log.create({
      data: {
        azione: 'UPDATE', entita: 'situazione_finanziaria', entitaId: SF_ID,
        dettaglio: JSON.stringify({
          tipo: 'fix-manuale-perrone',
          contrattoId: c.id, giocatoreId: GIOCATORE_ID, giocatoreNome: 'Maximo Perrone',
          fantaTeamId: FANTATEAM_ID, storno: QUOT_VALORE,
          motivo: 'storno accredito svincolo erroneo (inverso log#1177)',
          pre: sfPre, post: sfPost,
        }),
        adminId: ADMIN_ID,
      },
    });

    // Riga rosa: usa upsert per non duplicare se per caso esiste già
    const exist = await tx.rosaGiocatore.findFirst({
      where: { fantaTeamId: FANTATEAM_ID, giocatoreId: GIOCATORE_ID, stagione: STAGIONE_OLD },
    });
    if (!exist) {
      await tx.rosaGiocatore.create({
        data: {
          fantaTeamId: FANTATEAM_ID, giocatoreId: GIOCATORE_ID,
          stagione: STAGIONE_OLD, categoria: 'InRosa',
        },
      });
    }
  });

  console.log('\n[fix-perrone] Completato.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
