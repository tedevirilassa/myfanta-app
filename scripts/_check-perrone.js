require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const gioc = await p.giocatore.findMany({
    where: { nome: { contains: 'Perrone', mode: 'insensitive' } },
  });
  console.log('=== Giocatori match ===');
  for (const g of gioc) console.log(`#${g.id} ${g.nome} | valore=${g.valore} active=${g.active}`);

  for (const g of gioc) {
    const cs = await p.contratto.findMany({
      where: { giocatoreId: g.id },
      include: { fantaTeam: true },
      orderBy: { id: 'asc' },
    });
    console.log(`\n--- Contratti di ${g.nome} ---`);
    for (const c of cs) {
      console.log(`c#${c.id} team=${c.fantaTeam?.nome} tipo=${c.tipo} valido=${c.valido} stipula=${c.dataStipula} fine=${c.dataFine} dur=${c.durataContratto} stip=${c.importoOperazione} prezzo=${c.prezzoAcquisto} dest=${c.destinazione}`);
    }
    const ult = await p.quotazione.findFirst({
      where: { giocatoreId: g.id, fonte: 'transfermarkt' },
      orderBy: { createdAt: 'desc' },
    });
    console.log(`Ultima quot transfermarkt: ${ult ? ult.valore : '—'} @ ${ult?.createdAt}`);

    const rosa = await p.rosaGiocatore.findMany({
      where: { giocatoreId: g.id },
      include: { fantaTeam: true },
    });
    console.log(`Rose:`);
    for (const r of rosa) console.log(`  team=${r.fantaTeam?.nome} stag=${r.stagione} cat=${r.categoria}`);
  }

  const sf = await p.situazioneFinanziaria.findMany({
    where: { fantaTeamId: 11, stagione: '2025-2026' },
  });
  console.log('\n=== SF Parkinglover 2025-2026 ===');
  for (const s of sf) console.log(`SF#${s.id} crediti=${s.crediti} valR=${s.valoreRose} stip=${s.stipendi} gioc=${s.giocatoriTesserati}`);

  await p.$disconnect();
})();
