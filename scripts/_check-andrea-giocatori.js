require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  // Andrea ?
  const users = await p.user.findMany({
    where: {
      OR: [
        { nickname: { contains: 'Andrea', mode: 'insensitive' } },
        { email: { contains: 'andrea', mode: 'insensitive' } },
      ],
    },
    include: { fantaTeam: true },
  });
  console.log('Users Andrea:');
  console.log(JSON.stringify(users, null, 2));

  // Giocatori Raspadori / De Ketelaere
  const g = await p.giocatore.findMany({
    where: {
      OR: [
        { nome: { contains: 'Raspadori', mode: 'insensitive' } },
        { nome: { contains: 'Ketelaere', mode: 'insensitive' } },
      ],
    },
  });
  console.log('\nGiocatori:');
  console.log(JSON.stringify(g, null, 2));

  // Contratti per quei giocatori
  const ids = g.map((x) => x.id);
  if (ids.length) {
    const contratti = await p.contratto.findMany({
      where: { giocatoreId: { in: ids } },
      orderBy: [{ giocatoreId: 'asc' }, { createdAt: 'asc' }],
      include: { fantaTeam: true, giocatore: true },
    });
    console.log('\nContratti:');
    for (const c of contratti) {
      console.log({
        id: c.id,
        giocatore: c.giocatore?.nome,
        fantaTeam: c.fantaTeam?.nome,
        tipo: c.tipo,
        dataStipula: c.dataStipula,
        durata: c.durataContratto,
        dataFine: c.dataFine,
        valido: c.valido,
        provenienza: c.provenienza,
        destinazione: c.destinazione,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      });
    }

    // Rosa attuale
    const rosa = await p.rosaGiocatore.findMany({
      where: { giocatoreId: { in: ids } },
      include: { fantaTeam: true, giocatore: true },
    });
    console.log('\nRosaGiocatore (attuale):');
    for (const r of rosa) {
      console.log({
        id: r.id,
        giocatore: r.giocatore?.nome,
        fantaTeam: r.fantaTeam?.nome,
        stagione: r.stagione,
        categoria: r.categoria,
      });
    }

    // Log ultimi 30 giorni sui contratti dei due giocatori
    const logs = await p.log.findMany({
      where: {
        entita: { in: ['Contratto', 'RosaGiocatore', 'Giocatore'] },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const filtered = logs.filter((l) => {
      try {
        const s = JSON.stringify(l.dettaglio || {});
        return /raspadori|ketelaere/i.test(s);
      } catch {
        return false;
      }
    });
    console.log('\nLog (ultimi 30gg, filtrati per Raspadori/Ketelaere):');
    console.log(JSON.stringify(filtered, null, 2));
  }

  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
