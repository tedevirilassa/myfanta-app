require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  // Prendi un log SF e un log contratto della run incriminata per vedere
  // la struttura completa (rollbackSQL incluso)
  const contractIdsCampione = [354, 361]; // De Ketelaere + Raspadori (Bope El Burro)

  for (const cid of contractIdsCampione) {
    console.log(`\n===== contratto ${cid} =====`);
    const logs = await p.log.findMany({
      where: {
        entita: { in: ['contratto', 'situazione_finanziaria'] },
        createdAt: { gte: new Date('2026-06-04T15:05:00Z'), lte: new Date('2026-06-04T15:07:00Z') },
      },
      orderBy: { createdAt: 'asc' },
    });
    // contratto direttamente
    const cLogs = logs.filter((l) => l.entita === 'contratto' && l.entitaId === cid);
    console.log(`-- log contratto (${cLogs.length}):`);
    for (const l of cLogs) console.log(JSON.stringify(l, null, 2));

    // SF: trovo i log SF con dettaglio.contrattoId === cid
    const sfLogs = logs.filter((l) => {
      if (l.entita !== 'situazione_finanziaria') return false;
      try {
        const d = typeof l.dettaglio === 'string' ? JSON.parse(l.dettaglio) : l.dettaglio;
        return d.contrattoId === cid;
      } catch {
        return false;
      }
    });
    console.log(`-- log SF (${sfLogs.length}):`);
    for (const l of sfLogs) console.log(JSON.stringify(l, null, 2));
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
