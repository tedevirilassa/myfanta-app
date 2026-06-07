require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Trova le squadre borsello e tappina
  const teams = await prisma.fantaTeam.findMany({
    where: { nome: { contains: 'borsello', mode: 'insensitive' } },
    select: { id: true, nome: true }
  });
  console.log('=== SQUADRE ===');
  console.log(JSON.stringify(teams, null, 2));

  for (const team of teams) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SQUADRA: ${team.nome} (id=${team.id})`);
    console.log('='.repeat(60));

    // Rosa attuale (contratti validi)
    const rosa = await prisma.contratto.findMany({
      where: { fantaTeamId: team.id, valido: true },
      include: { giocatore: { select: { id: true, nome: true, ruolo: true, squadra: true } } },
      orderBy: { dataFine: 'asc' }
    });
    console.log(`\n--- ROSA ATTIVA (${rosa.length} giocatori) ---`);
    for (const c of rosa) {
      console.log(`  [${c.giocatore.ruolo}] ${c.giocatore.nome} (${c.giocatore.squadra}) | tipo=${c.tipo} | stipendio=${c.importoOperazione} | dataFine=${c.dataFine} | durata=${c.durataContratto} | dataStipula=${c.dataStipula} | contrattoId=${c.id}`);
    }

    // Storico contratti non validi
    const storico = await prisma.contratto.findMany({
      where: { fantaTeamId: team.id, valido: false },
      include: { giocatore: { select: { id: true, nome: true, ruolo: true } } },
      orderBy: { createdAt: 'desc' }
    });
    console.log(`\n--- STORICO CONTRATTI NON VALIDI (${storico.length}) ---`);
    for (const c of storico) {
      console.log(`  [${c.giocatore.ruolo}] ${c.giocatore.nome} | tipo=${c.tipo} | dataFine=${c.dataFine} | dataStipula=${c.dataStipula} | contrattoId=${c.id}`);
    }

    // Log azioni su tutti i contratti di questa squadra (sia attivi che non)
    const tuttiContrattiIds = [...rosa, ...storico].map(c => c.id);
    const logContratti = await prisma.log.findMany({
      where: {
        entita: { in: ['contratto', 'rinnovo'] },
        entitaId: { in: tuttiContrattiIds }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Cerca anche log con entitaId = id giocatori della rosa (per catturare rinnovi loggati per giocatoreId)
    const giocatoreIds = [...rosa, ...storico].map(c => c.giocatoreId).filter(Boolean);
    const logGiocatori = await prisma.log.findMany({
      where: {
        entita: { in: ['contratto', 'rinnovo'] },
        entitaId: { in: giocatoreIds }
      },
      orderBy: { createdAt: 'desc' }
    });

    const logRinnovi = [...logContratti, ...logGiocatori]
      .filter((l, i, arr) => arr.findIndex(x => x.id === l.id) === i)
      .sort((a, b) => b.createdAt - a.createdAt);
    console.log(`\n--- LOG AZIONI CONTRATTO per "${team.nome}" (${logRinnovi.length}) ---`);
    for (const l of logRinnovi) {
      let det = '';
      try { det = JSON.stringify(JSON.parse(l.dettaglio || '{}'), null, 0).slice(0, 200); } catch {}
      console.log(`  [${l.createdAt.toISOString().slice(0,19)}] ${l.azione} | ${l.entita} #${l.entitaId} | ${l.messaggio || ''} | rollbacked=${l.rollbacked}`);
      console.log(`    dettaglio: ${det}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
