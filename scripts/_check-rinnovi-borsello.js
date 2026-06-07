require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const TEAM_ID = 3; // Borsello e Tappina

  const rosaIds = [535, 252, 235, 244, 247, 533, 251, 231, 228, 240, 241, 236, 245, 234, 239, 531, 532, 534];
  const storicoIds = [250, 249, 248, 246, 243, 242, 238, 237, 233, 232, 230, 229, 226, 225, 224, 223, 222, 221];
  const allIds = [...rosaIds, ...storicoIds];

  console.log('=== DETTAGLIO RINNOVI FINE STAGIONE (2025→2026) per Borsello e Tappina ===\n');

  // Log CREATE fine-stagione-rinnovo per contratti borsello
  const logRinnovi = await prisma.log.findMany({
    where: { azione: 'CREATE', entita: 'contratto', entitaId: { in: rosaIds } },
    orderBy: { createdAt: 'asc' }
  });

  const rinnoviData = [];
  for (const l of logRinnovi) {
    let det = {};
    try { det = JSON.parse(l.dettaglio || '{}'); } catch {}
    if (det.tipo !== 'fine-stagione-rinnovo') continue;
    const preId = det.pre && det.pre.id;
    if (!allIds.includes(preId)) continue;

    const contratto = await prisma.contratto.findUnique({
      where: { id: l.entitaId },
      include: { giocatore: { select: { nome: true, ruolo: true, squadra: true } } }
    });

    rinnoviData.push({
      giocatore: contratto && contratto.giocatore && contratto.giocatore.nome || '???',
      ruolo: contratto && contratto.giocatore && contratto.giocatore.ruolo || '?',
      squadra: contratto && contratto.giocatore && contratto.giocatore.squadra || '?',
      preContrattoId: preId,
      preStipendio: det.pre && det.pre.importoOperazione,
      preDurata: det.pre && det.pre.durataContratto,
      quotazione: det.quotazione,
      nuovoContrattoId: l.entitaId,
      nuovoStipendio: det.post && det.post.importoOperazione,
      nuovaDurata: det.post && det.post.durataContratto,
      nuovaDataFine: det.post && det.post.dataFine,
      propostaId: det.propostaId,
    });
  }

  console.log('--- RINNOVI EFFETTUATI ---');
  for (const r of rinnoviData) {
    console.log('  [' + r.ruolo + '] ' + r.giocatore + ' (' + r.squadra + ')');
    console.log('       Vecchio: #' + r.preContrattoId + ' | stipendio=' + r.preStipendio + ' | durata=' + r.preDurata);
    console.log('       Nuovo:   #' + r.nuovoContrattoId + ' | stipendio=' + r.nuovoStipendio + ' | durata=' + r.nuovaDurata + ' | scade=' + r.nuovaDataFine + ' | quotazione=' + r.quotazione);
  }

  // Svincoli per contratti di borsello
  const logSvincoli = await prisma.log.findMany({
    where: { azione: 'UPDATE', entita: 'contratto', entitaId: { in: storicoIds } },
    orderBy: { createdAt: 'asc' }
  });

  const svincoli = [];
  for (const l of logSvincoli) {
    let det = {};
    try { det = JSON.parse(l.dettaglio || '{}'); } catch {}
    if (!det.tipo || !det.tipo.startsWith('fine-stagione')) continue;
    const contratto = await prisma.contratto.findUnique({
      where: { id: l.entitaId },
      include: { giocatore: { select: { nome: true, ruolo: true, squadra: true } } }
    });
    svincoli.push({
      contrattoId: l.entitaId,
      giocatore: contratto && contratto.giocatore && contratto.giocatore.nome || '???',
      ruolo: contratto && contratto.giocatore && contratto.giocatore.ruolo || '?',
      squadra: contratto && contratto.giocatore && contratto.giocatore.squadra || '?',
      tipo: contratto && contratto.tipo,
      motivo: det.motivo,
      stipendio: det.pre && det.pre.importoOperazione,
    });
  }

  const bocciati = svincoli.filter(function(s) { return s.motivo === 'rinnovo-bocciato'; });
  const naturali = svincoli.filter(function(s) { return s.motivo === 'scadenza-naturale'; });

  console.log('\n--- SVINCOLI FINE STAGIONE ---');
  console.log('\n  RINNOVO BOCCIATO:');
  bocciati.forEach(function(s) {
    console.log('  [' + s.ruolo + '] ' + s.giocatore + ' (' + s.squadra + ') | tipo=' + s.tipo + ' | stipendio era=' + s.stipendio);
  });
  console.log('\n  SCADENZA NATURALE:');
  naturali.forEach(function(s) {
    console.log('  [' + s.ruolo + '] ' + s.giocatore + ' (' + s.squadra + ') | tipo=' + s.tipo + ' | stipendio era=' + s.stipendio);
  });

  // Contratti confermati (stipulati nel 2025, non toccati dalla fine stagione)
  const confermati = await prisma.contratto.findMany({
    where: { fantaTeamId: TEAM_ID, valido: true, dataStipula: '07-2025' },
    include: { giocatore: { select: { nome: true, ruolo: true, squadra: true } } },
    orderBy: [{ giocatore: { ruolo: 'asc' } }]
  });

  console.log('\n--- CONTRATTI CONFERMATI (stipulati 07-2025, non toccati dalla fine stagione) ---');
  confermati.forEach(function(c) {
    console.log('  [' + c.giocatore.ruolo + '] ' + c.giocatore.nome + ' (' + c.giocatore.squadra + ') | stipendio=' + c.importoOperazione + ' | scade=' + c.dataFine + ' | durata=' + c.durataContratto);
  });

  await prisma.$disconnect();
}

main().catch(function(e) { console.error(e); process.exit(1); });
