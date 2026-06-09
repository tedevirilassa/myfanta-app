require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  // Log a quella ora esatta
  const start = new Date('2026-06-04T15:05:00.000Z');
  const end = new Date('2026-06-04T15:07:00.000Z');
  const logs = await p.log.findMany({
    where: { createdAt: { gte: start, lte: end } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Log fra ${start.toISOString()} e ${end.toISOString()}: ${logs.length}`);
  for (const l of logs.slice(0, 30)) {
    console.log({
      id: l.id,
      azione: l.azione,
      entita: l.entita,
      entitaId: l.entitaId,
      adminId: l.adminId,
      createdAt: l.createdAt,
      dettaglio: typeof l.dettaglio === 'string' ? l.dettaglio.slice(0, 200) : JSON.stringify(l.dettaglio).slice(0, 200),
    });
  }
  console.log(`(visualizzati ${Math.min(30, logs.length)} di ${logs.length})`);

  // Quanti contratti sono stati settati a valido=false in quella finestra?
  const cnt = await p.contratto.count({
    where: { valido: false, updatedAt: { gte: start, lte: end } },
  });
  console.log(`\nContratti settati valido=false in quella finestra: ${cnt}`);

  // Quanti per team?
  const byTeam = await p.contratto.groupBy({
    by: ['fantaTeamId'],
    where: { valido: false, updatedAt: { gte: start, lte: end } },
    _count: true,
  });
  console.log('Per team:', byTeam);

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
