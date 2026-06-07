require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  // Tutti gli utenti con il loro fantaTeam
  const users = await prisma.user.findMany({
    where: { fantaTeam: { isNot: null } },
    select: { id: true, email: true, nickname: true, fantaTeam: { select: { id: true, nome: true } } },
  });

  // SF con fantaTeamId null
  const sfNulli = await prisma.situazioneFinanziaria.findMany({
    where: { fantaTeamId: null },
    select: { id: true, nomePresidente: true, stagione: true },
  });

  console.log(`SF con fantaTeamId null: ${sfNulli.length}`);
  if (sfNulli.length === 0) { console.log('Niente da correggere.'); return; }

  const norm = (s) => (s || '').trim().toLowerCase();

  let fixati = 0;
  let nonTrovati = [];

  for (const sf of sfNulli) {
    const nP = norm(sf.nomePresidente);
    let team = null;

    // 1. Nickname esatto
    for (const u of users) {
      if (u.nickname && norm(u.nickname) === nP) { team = u.fantaTeam; break; }
    }
    // 2. Email prefix esatto
    if (!team) {
      for (const u of users) {
        if (u.email && norm(u.email.split('@')[0]) === nP) { team = u.fantaTeam; break; }
      }
    }
    // 3. nomePresidente è sottostringa dell'email
    if (!team) {
      for (const u of users) {
        if (u.email && norm(u.email).includes(nP)) { team = u.fantaTeam; break; }
      }
    }

    if (team) {
      await prisma.situazioneFinanziaria.update({
        where: { id: sf.id },
        data: { fantaTeamId: team.id },
      });
      console.log(`  ✓ SF #${sf.id} (${sf.nomePresidente}, ${sf.stagione}) → fantaTeamId=${team.id} (${team.nome})`);
      fixati++;
    } else {
      nonTrovati.push(`SF #${sf.id} (${sf.nomePresidente}, ${sf.stagione})`);
    }
  }

  console.log(`\nFixati: ${fixati}/${sfNulli.length}`);
  if (nonTrovati.length) {
    console.log('Non risolti (nessun match trovato):');
    nonTrovati.forEach(x => console.log('  ✗ ' + x));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
