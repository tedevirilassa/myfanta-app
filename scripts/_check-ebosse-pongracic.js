require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const names = ['Ebosse', 'Pongracic'];
  for (const n of names) {
    const gioc = await p.giocatore.findMany({
      where: { nome: { contains: n, mode: 'insensitive' } },
    });
    for (const g of gioc) {
      console.log(`\n=== #${g.id} ${g.nome} (valore=${g.valore}) ===`);
      const cs = await p.contratto.findMany({
        where: { giocatoreId: g.id },
        include: { fantaTeam: true },
        orderBy: { id: 'asc' },
      });
      for (const c of cs) {
        console.log(`c#${c.id} team=${c.fantaTeam?.nome} tipo=${c.tipo} valido=${c.valido} stip=${c.dataStipula} fine=${c.dataFine} dur=${c.durataContratto} importoOp=${c.importoOperazione} prezzo=${c.prezzoAcquisto} dest=${c.destinazione}`);
      }
      const q = await p.quotazione.findFirst({
        where: { giocatoreId: g.id, fonte: 'transfermarkt' },
        orderBy: { createdAt: 'desc' },
      });
      console.log(`ultQuot=${q?.valore}`);
      const rosa = await p.rosaGiocatore.findMany({
        where: { giocatoreId: g.id },
        include: { fantaTeam: true },
      });
      for (const r of rosa) console.log(`  rosa: team=${r.fantaTeam?.nome} stag=${r.stagione} cat=${r.categoria}`);
      // Proposte rinnovo
      const pr = await p.propostaRinnovo.findMany({ where: { giocatoreId: g.id } });
      for (const x of pr) console.log(`  proposta: id=${x.id} stag=${x.stagione} status=${x.status} cId=${x.contrattoId}`);
    }
  }

  const sf = await p.situazioneFinanziaria.findFirst({
    where: { fantaTeamId: 9, stagione: '2025-2026' },
    include: { fantaTeam: true },
  });
  console.log(`\n=== SF Giannik (Luca) ===`);
  console.log(`SF#${sf?.id} crediti=${sf?.crediti} valR=${sf?.valoreRose} stip=${sf?.stipendi} gioc=${sf?.giocatoriTesserati}`);

  await p.$disconnect();
})();
