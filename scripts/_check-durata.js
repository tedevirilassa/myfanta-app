require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

p.contratto.findMany({
  where: { id: { in: [490, 511] } },
  select: { id: true, durataContratto: true, dataFine: true, valido: true },
}).then(r => {
  r.forEach(x => console.log(JSON.stringify(x)));
}).catch(console.error).finally(() => p.$disconnect());
