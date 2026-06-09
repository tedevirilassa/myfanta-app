require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const start = new Date('2026-06-04T15:05:00.000Z');
  const end = new Date('2026-06-04T15:07:00.000Z');

  // Tutti i contratti invalidati in quella finestra
  const cs = await p.contratto.findMany({
    where: { valido: false, updatedAt: { gte: start, lte: end } },
    include: { giocatore: true, fantaTeam: true },
    orderBy: { id: 'asc' },
  });

  const FINE_STAG_ANNO = 2026; // stagione 2025-2026
  const incongruenti = [];
  for (const c of cs) {
    if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) continue;
    const annoFine = parseInt(c.dataFine.split('-')[1], 10);
    if (annoFine > FINE_STAG_ANNO) {
      incongruenti.push({
        id: c.id,
        giocatore: c.giocatore?.nome,
        team: c.fantaTeam?.nome,
        dataStipula: c.dataStipula,
        durata: c.durataContratto,
        dataFine: c.dataFine,
        tipo: c.tipo,
        importoOperazione: c.importoOperazione ? Number(c.importoOperazione) : 0,
      });
    }
  }

  console.log(`Contratti invalidati nella finestra: ${cs.length}`);
  console.log(`Di questi, con dataFine FUTURA (> ${FINE_STAG_ANNO}): ${incongruenti.length}\n`);
  for (const x of incongruenti) {
    console.log(JSON.stringify(x));
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
