require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const logs = await p.log.findMany({
    where: { entita: 'contratto', entitaId: 498 },
    orderBy: { id: 'asc' },
  });
  console.log('=== Log contratto 498 ===');
  for (const l of logs) {
    console.log(`\nlog#${l.id} ${l.azione} rollbacked=${l.rollbacked} created=${l.createdAt}`);
    try { console.dir(JSON.parse(l.dettaglio), { depth: 4 }); } catch { console.log(l.dettaglio); }
  }

  // log SF Parkinglover legati al giocatore 232 (Perrone) o al contratto 498
  const sfLogs = await p.log.findMany({
    where: { entita: 'situazione_finanziaria', dettaglio: { contains: '"contrattoId":498' } },
    orderBy: { id: 'asc' },
  });
  console.log('\n=== Log SF collegati a contratto 498 ===');
  for (const l of sfLogs) {
    console.log(`\nlog#${l.id} entId=${l.entitaId} rollbacked=${l.rollbacked} created=${l.createdAt}`);
    try { console.dir(JSON.parse(l.dettaglio), { depth: 4 }); } catch { console.log(l.dettaglio); }
  }

  await p.$disconnect();
})();
