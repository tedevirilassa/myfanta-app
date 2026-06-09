require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { getRemainingContractYears } = require('../src/utils/contractUtils');

const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

(async () => {
  const STAGIONE_OLD = '2025-2026';
  const STAGIONE_NEW = '2026-2027';

  // Tutti i contratti validi con TUTTI i dettagli
  const contratti = await p.contratto.findMany({
    where: { valido: true },
    include: { giocatore: true, fantaTeam: { include: { user: true } } },
    orderBy: { fantaTeamId: 'asc' },
  });

  // Tutte le proposte di rinnovo per la nuova stagione
  const proposte = await p.propostaRinnovo.findMany({
    where: { stagione: STAGIONE_NEW },
    select: { contrattoId: true, status: true, fantaTeamId: true },
  });
  const conProposta = new Map(proposte.map((x) => [x.contrattoId, x.status]));

  // Tutte le righe RosaGiocatore stagione corrente
  const rosa = await p.rosaGiocatore.findMany({
    where: { stagione: STAGIONE_OLD },
    select: { fantaTeamId: true, giocatoreId: true, categoria: true },
  });
  const rosaMap = new Map(
    rosa.map((r) => [`${r.fantaTeamId}:${r.giocatoreId}`, r.categoria])
  );

  // Filtra: contratti con 0 anni residui secondo il helper (regola di Giugno attiva)
  const conZeroAnni = [];
  for (const c of contratti) {
    const anni = getRemainingContractYears(c.dataFine);
    if (anni === 0) conZeroAnni.push({ c, anni });
  }

  console.log(`Contratti totali validi: ${contratti.length}`);
  console.log(`Contratti con 0 anni residui (regola di Giugno): ${conZeroAnni.length}\n`);

  // Raggruppa per team con dettaglio stato (proposta/rosa)
  const byTeam = {};
  for (const x of conZeroAnni) {
    const c = x.c;
    const teamNome = c.fantaTeam?.nome || `team-${c.fantaTeamId}`;
    const presNome = c.fantaTeam?.user
      ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email)
      : '—';
    const key = `${teamNome} (${presNome})`;
    if (!byTeam[key]) byTeam[key] = [];

    const rosaKey = `${c.fantaTeamId}:${c.giocatoreId}`;
    const categoria = rosaMap.get(rosaKey) || '—';
    const statoProposta = conProposta.get(c.id) || null;

    byTeam[key].push({
      id: c.id,
      giocatore: c.giocatore?.nome,
      tipo: c.tipo,
      dataFine: c.dataFine,
      durata: c.durataContratto,
      stip: c.importoOperazione ? Number(c.importoOperazione) : 0,
      val: c.giocatore?.valore ? Number(c.giocatore.valore) : 0,
      inRosa: rosaMap.has(rosaKey),
      categoria,
      proposta: statoProposta,
    });
  }

  // Stampa
  for (const [team, lista] of Object.entries(byTeam)) {
    console.log(`\n=== ${team} (${lista.length}) ===`);
    for (const x of lista) {
      const flags = [];
      if (!x.inRosa) flags.push('NON IN ROSA');
      else flags.push(`rosa=${x.categoria}`);
      if (x.proposta) flags.push(`proposta=${x.proposta}`);
      else flags.push('NO proposta');
      console.log(
        `  c#${x.id} | ${x.giocatore.padEnd(28)} | ${x.tipo.padEnd(10)} | ` +
        `dataFine=${x.dataFine || '—'} dur=${x.durata} | ` +
        `stip=${x.stip.toFixed(2)} val=${x.val.toFixed(2)} | ${flags.join(' · ')}`
      );
    }
  }

  // Riepilogo: candidati svincolo (in rosa non U21, senza proposta)
  const svincolabili = conZeroAnni.filter((x) => {
    const c = x.c;
    const rosaKey = `${c.fantaTeamId}:${c.giocatoreId}`;
    return rosaMap.has(rosaKey)
      && rosaMap.get(rosaKey) !== 'U21'
      && !conProposta.has(c.id);
  });

  console.log(`\n=== RIEPILOGO ===`);
  console.log(`Totali con 0 anni: ${conZeroAnni.length}`);
  console.log(`Candidati svincolo (in rosa NON U21, senza proposta): ${svincolabili.length}`);
  if (svincolabili.length) {
    for (const x of svincolabili) {
      console.log(`  → c#${x.c.id} ${x.c.giocatore?.nome} (${x.c.fantaTeam?.nome})`);
    }
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
