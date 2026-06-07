require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  const rows = await p.contratto.findMany({
    where: { fantaTeamId: 11, valido: true },
    include: { giocatore: { select: { nome: true, ruolo: true } } },
    orderBy: { dataFine: 'asc' },
  });

  const mm = 7; // giugno trattato come luglio
  const yyyy = new Date().getFullYear();

  console.log('Anni | DataFine  | Tipo     | Stipendio | Giocatore');
  console.log('-----|-----------|----------|-----------|-------------------');
  for (const c of rows) {
    let anni = c.durataContratto;
    if (c.dataFine && /^\d{2}-\d{4}$/.test(c.dataFine)) {
      const [mf, yf] = c.dataFine.split('-').map(Number);
      const diff = (yf - yyyy) * 12 + (mf - mm);
      anni = Math.max(0, Math.ceil(diff / 12));
    }
    const stip = c.importoOperazione ? Number(c.importoOperazione).toFixed(2) : '?';
    console.log(
      `${anni.toString().padStart(4)} | ${(c.dataFine||'null').padEnd(9)} | ${c.tipo.padEnd(8)} | ${stip.padStart(9)} | ${c.giocatore.nome} [${c.giocatore.ruolo}] id=${c.id}`
    );
  }

  // Cerca anche eventuali propostaRinnovo per questi contratti
  const ids = rows.map(c => c.id);
  const proposte = await p.propostaRinnovo.findMany({ where: { contrattoId: { in: ids } }, select: { contrattoId: true, status: true, nuovaDurata: true } });
  if (proposte.length) {
    console.log('\nProposte rinnovo:');
    proposte.forEach(pr => console.log(`  contrattoId=${pr.contrattoId} status=${pr.status} nuovaDurata=${pr.nuovaDurata}`));
  } else {
    console.log('\nNessuna proposta rinnovo trovata per questi contratti.');
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
