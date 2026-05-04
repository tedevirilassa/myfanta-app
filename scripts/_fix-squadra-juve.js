'use strict';
require('dotenv').config();
const prisma = require('../src/lib/prisma');

async function main() {
  const result = await prisma.giocatore.updateMany({
    where: { squadra: 'Juve' },
    data:  { squadra: 'Juventus' },
  });
  console.log('Aggiornati:', result.count);
}

main().catch(console.error).finally(() => prisma.$disconnect());
