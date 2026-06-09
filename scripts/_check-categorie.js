require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const r = await p.rosaGiocatore.groupBy({ by: ['categoria', 'stagione'], _count: true });
  console.log('Categorie per stagione:');
  console.log(r);

  // Esempio per Bope El Burro (team 7)
  const rosa = await p.rosaGiocatore.findMany({
    where: { fantaTeamId: 7 },
    select: { categoria: true, stagione: true, giocatoreId: true },
    take: 10,
  });
  console.log('\nEsempi Bope El Burro:');
  console.log(rosa);

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
