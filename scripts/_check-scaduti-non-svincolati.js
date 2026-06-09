require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const ANNO_FINE_STAGIONE = 2026;
  const STAGIONE = '2025-2026';

  // 1. Contratti validi con scadenza nell'anno corrente o precedente (cioè
  // anno dataFine <= 2026), per cui non è stato fatto svincolo.
  const tutti = await p.contratto.findMany({
    where: { valido: true },
    include: { giocatore: true, fantaTeam: { include: { user: true } } },
    orderBy: { id: 'asc' },
  });

  const scaduti = tutti.filter((c) => {
    if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) return false;
    return parseInt(c.dataFine.split('-')[1], 10) <= ANNO_FINE_STAGIONE;
  });

  console.log(`Contratti validi totali: ${tutti.length}`);
  console.log(`Contratti validi con dataFine <= ${ANNO_FINE_STAGIONE}: ${scaduti.length}\n`);

  // 2. Per ognuno: ha una PropostaRinnovo PENDING per stagione 2026-2027?
  const ids = scaduti.map((c) => c.id);
  const proposte = await p.propostaRinnovo.findMany({
    where: { contrattoId: { in: ids }, stagione: '2026-2027' },
    select: { contrattoId: true, status: true },
  });
  const conProposta = new Set(proposte.map((x) => x.contrattoId));

  const senzaProposta = scaduti.filter((c) => !conProposta.has(c.id));

  // 3. Filtra: deve essere in rosa (RosaGiocatore stagione 2025-2026)
  const rosaPairs = await p.rosaGiocatore.findMany({
    where: {
      stagione: STAGIONE,
      giocatoreId: { in: senzaProposta.map((c) => c.giocatoreId) },
      fantaTeamId: { in: senzaProposta.map((c) => c.fantaTeamId) },
    },
    select: { fantaTeamId: true, giocatoreId: true, categoria: true },
  });
  const rosaMap = new Map();
  for (const r of rosaPairs) {
    rosaMap.set(`${r.fantaTeamId}:${r.giocatoreId}`, r.categoria);
  }

  const candidati = senzaProposta
    .filter((c) => rosaMap.has(`${c.fantaTeamId}:${c.giocatoreId}`))
    .filter((c) => rosaMap.get(`${c.fantaTeamId}:${c.giocatoreId}`) !== 'U21'); // U21 protetti

  console.log(`Senza proposta rinnovo: ${senzaProposta.length}`);
  console.log(`Di cui in rosa (non U21): ${candidati.length}\n`);

  // Stampa per team
  const byTeam = {};
  for (const c of candidati) {
    const nome = c.fantaTeam?.nome || `team-${c.fantaTeamId}`;
    if (!byTeam[nome]) byTeam[nome] = [];
    byTeam[nome].push({
      id: c.id,
      giocatore: c.giocatore?.nome,
      dataFine: c.dataFine,
      durata: c.durataContratto,
      tipo: c.tipo,
      stipendio: c.importoOperazione ? Number(c.importoOperazione) : 0,
      valore: c.giocatore?.valore ? Number(c.giocatore.valore) : 0,
      categoria: rosaMap.get(`${c.fantaTeamId}:${c.giocatoreId}`),
    });
  }
  for (const [team, lista] of Object.entries(byTeam)) {
    console.log(`\n=== ${team} (${lista.length} giocatori) ===`);
    let totStip = 0, totVal = 0;
    for (const x of lista) {
      console.log(`  c#${x.id} | ${x.giocatore.padEnd(28)} | ${x.tipo.padEnd(10)} | dataFine=${x.dataFine} | dur=${x.durata} | stip=${x.stipendio.toFixed(2)} | val=${x.valore.toFixed(2)} | ${x.categoria}`);
      totStip += x.stipendio;
      totVal += x.valore;
    }
    console.log(`  → totali: stipendi=${totStip.toFixed(2)}  valore=${totVal.toFixed(2)}`);
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
