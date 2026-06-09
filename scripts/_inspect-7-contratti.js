require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const ids = [321, 314, 379, 387, 431, 511, 490];
  const cs = await p.contratto.findMany({
    where: { id: { in: ids } },
    include: { giocatore: true, fantaTeam: true },
  });
  for (const c of cs) {
    const q = await p.quotazione.findFirst({
      where: { giocatoreId: c.giocatoreId, fonte: 'transfermarkt' },
      orderBy: { createdAt: 'desc' },
      select: { valore: true, createdAt: true },
    });
    console.log(
      `c#${c.id} | ${c.giocatore.nome.padEnd(25)} | ${c.fantaTeam.nome.padEnd(20)} | ` +
      `tipo=${c.tipo} dest=${c.destinazione || 'null'} | ` +
      `stip=${c.importoOperazione} valGioc=${c.giocatore.valore} | ` +
      `ultQuot=${q ? q.valore : '—'}`
    );
  }
  console.log('\n--- SF dei team coinvolti ---');
  const teamIds = [...new Set(cs.map(c => c.fantaTeamId))];
  const sfs = await p.situazioneFinanziaria.findMany({
    where: { fantaTeamId: { in: teamIds }, stagione: '2025-2026' },
    include: { fantaTeam: true },
  });
  for (const sf of sfs) {
    console.log(`SF#${sf.id} ${sf.fantaTeam.nome.padEnd(20)} | crediti=${sf.crediti} valR=${sf.valoreRose} stip=${sf.stipendi} gioc=${sf.giocatoriTesserati}`);
  }
  await p.$disconnect();
})();
