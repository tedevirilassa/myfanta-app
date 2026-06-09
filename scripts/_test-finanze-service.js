// scripts/_test-finanze-service.js
// Smoke-test del nuovo helper modificaCreditiTeam:
// 1. Movimento valido → applica delta, scrive log + movimento, ritorna SF aggiornata
// 2. Movimento con capienza insufficiente → throw InsufficientCreditiError + rollback transazione
// 3. Causale invalida → throw
// Tutto avviene in una transazione che fa ROLLBACK alla fine, quindi non lascia tracce.

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { modificaCreditiTeam, CAUSALI, InsufficientCreditiError } =
  require('../src/services/finanze.service');

(async () => {
  const sf = await prisma.situazioneFinanziaria.findFirst({
    where: { fantaTeamId: 11, stagione: '2025-2026' },
  });
  console.log(`SF#${sf.id} (${sf.nomePresidente}) crediti=${sf.crediti} stipendi=${sf.stipendi}`);

  // TEST 1: movimento valido + rollback
  console.log('\n[T1] Movimento valido in transazione con ROLLBACK forzato');
  try {
    await prisma.$transaction(async (tx) => {
      const r = await modificaCreditiTeam(tx, {
        fantaTeamId: 11, stagione: '2025-2026',
        deltaCrediti: -5, deltaStipendi: +5,
        causale: CAUSALI.PAGAMENTO_STIPENDIO_RINNOVO,
        contesto: { test: 'smoke-T1', contrattoFittizio: 999 },
        adminId: 2,
      });
      console.log(`  pre.crediti=${r.pre.crediti} post.crediti=${r.post.crediti} mov#${r.movimento.id} log#${r.log.id}`);
      throw new Error('ROLLBACK_INTENZIONALE');
    });
  } catch (e) {
    if (e.message !== 'ROLLBACK_INTENZIONALE') throw e;
    console.log('  ✓ rollback eseguito');
  }
  const sfPost1 = await prisma.situazioneFinanziaria.findUnique({ where: { id: sf.id } });
  if (Number(sfPost1.crediti) !== Number(sf.crediti)) {
    throw new Error(`SF.crediti cambiata dopo rollback! pre=${sf.crediti} post=${sfPost1.crediti}`);
  }
  console.log(`  ✓ SF.crediti invariato (${sfPost1.crediti})`);

  // TEST 2: capienza insufficiente
  console.log('\n[T2] Movimento con capienza insufficiente');
  try {
    await prisma.$transaction(async (tx) => {
      await modificaCreditiTeam(tx, {
        fantaTeamId: 11, stagione: '2025-2026',
        deltaCrediti: -1000000,
        causale: CAUSALI.PAGAMENTO_STIPENDIO_P2P,
        adminId: 2,
      });
    });
    throw new Error('Doveva fallire ma non l\'ha fatto');
  } catch (e) {
    if (!(e instanceof InsufficientCreditiError)) throw e;
    console.log(`  ✓ throw atteso: ${e.message}`);
  }

  // TEST 3: causale invalida
  console.log('\n[T3] Causale invalida');
  try {
    await prisma.$transaction(async (tx) => {
      await modificaCreditiTeam(tx, {
        fantaTeamId: 11, stagione: '2025-2026',
        deltaCrediti: 0,
        causale: 'CAUSALE_INESISTENTE',
        adminId: 2,
      });
    });
    throw new Error('Doveva fallire ma non l\'ha fatto');
  } catch (e) {
    if (!e.message.includes('Causale non valida')) throw e;
    console.log(`  ✓ throw atteso: ${e.message.slice(0, 80)}`);
  }

  console.log('\nTutti i test passati.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
