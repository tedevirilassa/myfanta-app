/**
 * scripts/svincola-scaduti-non-svincolati.js
 *
 * Svincola retroattivamente i contratti che:
 *   - sono valido=true
 *   - hanno dataFine con anno <= 2026 (stagione 2025-2026)
 *   - NON hanno una PropostaRinnovo per la stagione 2026-2027
 *   - hanno una RosaGiocatore stagione 2025-2026 NON U21
 *
 * Applica esattamente la stessa logica di svincolo di
 * `eseguiFineStagione` Step 3 (vedi src/controllers/fine-stagione.controller.js):
 *   - contratto.valido = false, destinazione = destinazione || "Scaduto"
 *   - per "Acquisto": SF crediti += quotValore, valoreRose -= quotValore,
 *     giocatoriTesserati -= 1, stipendi -= importoOperazione
 *   - elimina RosaGiocatore stagione vecchia
 *
 * Uso:
 *   node scripts/svincola-scaduti-non-svincolati.js              → dry-run
 *   node scripts/svincola-scaduti-non-svincolati.js --execute    → applica
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const ANNO_FINE_STAGIONE = 2026;
const STAGIONE_OLD = '2025-2026';
const STAGIONE_NEW = '2026-2027';
const ADMIN_ID = 2;

const DRY_RUN = !process.argv.includes('--execute');

function log(m) { console.log(`[svincola] ${m}`); }

async function ultimaQuotazione(tx, giocatoreId, fallback) {
  const q = await tx.quotazione.findFirst({
    where: { giocatoreId, fonte: 'transfermarkt' },
    orderBy: { createdAt: 'desc' },
    select: { valore: true },
  });
  if (q && q.valore != null) return Number(q.valore);
  return fallback != null ? Number(fallback) : 0;
}

async function main() {
  log(`Modalità: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  // 1. Selezione candidati
  const tutti = await prisma.contratto.findMany({
    where: { valido: true },
    include: { giocatore: true, fantaTeam: { include: { user: true } } },
  });
  const scaduti = tutti.filter((c) => {
    if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) return false;
    return parseInt(c.dataFine.split('-')[1], 10) <= ANNO_FINE_STAGIONE;
  });
  const proposte = await prisma.propostaRinnovo.findMany({
    where: { contrattoId: { in: scaduti.map(c => c.id) }, stagione: STAGIONE_NEW },
    select: { contrattoId: true },
  });
  const conProposta = new Set(proposte.map(x => x.contrattoId));
  const senzaProposta = scaduti.filter(c => !conProposta.has(c.id));

  const rosa = await prisma.rosaGiocatore.findMany({
    where: {
      stagione: STAGIONE_OLD,
      giocatoreId: { in: senzaProposta.map(c => c.giocatoreId) },
      fantaTeamId: { in: senzaProposta.map(c => c.fantaTeamId) },
    },
    select: { fantaTeamId: true, giocatoreId: true, categoria: true },
  });
  const rosaMap = new Map(rosa.map(r => [`${r.fantaTeamId}:${r.giocatoreId}`, r.categoria]));

  const candidati = senzaProposta
    .filter(c => rosaMap.has(`${c.fantaTeamId}:${c.giocatoreId}`))
    .filter(c => rosaMap.get(`${c.fantaTeamId}:${c.giocatoreId}`) !== 'U21');

  log(`Candidati: ${candidati.length}\n`);

  // 2. Pre-calcola quotazioni e delta
  const plan = [];
  for (const c of candidati) {
    const quot = await ultimaQuotazione(prisma, c.giocatoreId, c.giocatore?.valore);
    const stipendio = c.importoOperazione ? Number(c.importoOperazione) : 0;

    // SF target
    const presNome = c.fantaTeam.user ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email) : null;
    let sf = await prisma.situazioneFinanziaria.findFirst({
      where: { fantaTeamId: c.fantaTeamId, stagione: STAGIONE_OLD },
    });
    if (!sf && presNome) {
      sf = await prisma.situazioneFinanziaria.findFirst({
        where: { nomePresidente: presNome, stagione: STAGIONE_OLD },
      });
    }

    plan.push({
      contrattoId: c.id,
      giocatoreId: c.giocatoreId,
      giocatoreNome: c.giocatore.nome,
      fantaTeamId: c.fantaTeamId,
      teamNome: c.fantaTeam.nome,
      tipo: c.tipo,
      destinazioneCorrente: c.destinazione,
      stipendio, quotValore: quot,
      sf,
    });
  }

  log('Piano svincoli (delta cumulati per SF):');
  // Simula in memoria gli effetti cumulativi sulla stessa SF
  const sfState = new Map();
  for (const p of plan) {
    if (!p.sf) continue;
    if (!sfState.has(p.sf.id)) {
      sfState.set(p.sf.id, {
        crediti: Number(p.sf.crediti),
        valoreRose: Number(p.sf.valoreRose),
        giocatoriTesserati: p.sf.giocatoriTesserati,
        stipendi: Number(p.sf.stipendi),
      });
    }
  }
  for (const p of plan) {
    if (p.tipo === 'Acquisto' && p.sf) {
      const s = sfState.get(p.sf.id);
      const pre = { ...s };
      s.crediti            = Math.round((pre.crediti    + p.quotValore) * 100) / 100;
      s.valoreRose         = Math.round((pre.valoreRose - p.quotValore) * 100) / 100;
      s.giocatoriTesserati = Math.max(0, pre.giocatoriTesserati - 1);
      s.stipendi           = Math.round((pre.stipendi   - p.stipendio) * 100) / 100;
      console.log(
        `  c#${p.contrattoId} | ${p.giocatoreNome.padEnd(25)} | ${p.teamNome.padEnd(20)} | ${p.tipo.padEnd(8)} | ` +
        `quot=${p.quotValore.toFixed(2)} stip=${p.stipendio.toFixed(2)} | ` +
        `SF#${p.sf.id} crediti ${pre.crediti.toFixed(2)}→${s.crediti.toFixed(2)} ` +
        `valR ${pre.valoreRose.toFixed(2)}→${s.valoreRose.toFixed(2)} ` +
        `stip ${pre.stipendi.toFixed(2)}→${s.stipendi.toFixed(2)} ` +
        `gioc ${pre.giocatoriTesserati}→${s.giocatoriTesserati}`
      );
    } else {
      console.log(
        `  c#${p.contrattoId} | ${p.giocatoreNome.padEnd(25)} | ${p.teamNome.padEnd(20)} | ${p.tipo.padEnd(8)} | ` +
        `(no SF update: ${p.tipo === 'Acquisto' ? 'SF non trovata' : 'tipo Prestito'})`
      );
    }
  }

  if (DRY_RUN) {
    log('\nDRY-RUN: nessuna modifica. Rilancia con --execute per applicare.');
    return;
  }

  // 3. Esegui in transazione
  log('\nEsecuzione in transazione...');
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const c = await tx.contratto.findUnique({ where: { id: p.contrattoId } });
      const preContratto = {
        valido: true, tipo: c.tipo, durataContratto: c.durataContratto,
        giocatoreId: c.giocatoreId, fantaTeamId: c.fantaTeamId,
        importoOperazione: p.stipendio,
      };

      // Invalida contratto
      await tx.contratto.update({
        where: { id: c.id },
        data: { valido: false, destinazione: c.destinazione || 'Scaduto' },
      });

      // Update SF solo per Acquisto — RILEGGI SF fresca per gestire più
      // svincoli che toccano la stessa SF (più contratti dello stesso team)
      if (c.tipo === 'Acquisto' && p.sf) {
        const sfFresh = await tx.situazioneFinanziaria.findUnique({ where: { id: p.sf.id } });
        const pre = {
          crediti: Number(sfFresh.crediti),
          valoreRose: Number(sfFresh.valoreRose),
          giocatoriTesserati: sfFresh.giocatoriTesserati,
          stipendi: Number(sfFresh.stipendi),
        };
        const post = {
          crediti:            Math.round((pre.crediti    + p.quotValore) * 100) / 100,
          valoreRose:         Math.round((pre.valoreRose - p.quotValore) * 100) / 100,
          giocatoriTesserati: Math.max(0, pre.giocatoriTesserati - 1),
          stipendi:           Math.round((pre.stipendi   - p.stipendio) * 100) / 100,
        };
        await tx.situazioneFinanziaria.update({ where: { id: p.sf.id }, data: post });
        await tx.log.create({
          data: {
            azione: 'UPDATE',
            entita: 'situazione_finanziaria',
            entitaId: p.sf.id,
            dettaglio: JSON.stringify({
              tipo: 'svincolo-retroattivo-scaduto',
              contrattoId: c.id, giocatoreId: p.giocatoreId, giocatoreNome: p.giocatoreNome,
              fantaTeamId: p.fantaTeamId, quotazioneAccredito: p.quotValore,
              motivo: 'scaduto-non-rinnovato (manca pass nel rollover)',
              pre, post,
            }),
            adminId: ADMIN_ID,
          },
        });
      }

      // Elimina RosaGiocatore stagione vecchia
      await tx.rosaGiocatore.deleteMany({
        where: { fantaTeamId: p.fantaTeamId, giocatoreId: p.giocatoreId, stagione: STAGIONE_OLD },
      });

      // Log contratto
      await tx.log.create({
        data: {
          azione: 'UPDATE',
          entita: 'contratto',
          entitaId: c.id,
          dettaglio: JSON.stringify({
            tipo: 'svincolo-retroattivo-scaduto',
            motivo: 'scaduto-non-rinnovato',
            pre: preContratto,
            post: { valido: false, destinazione: c.destinazione || 'Scaduto' },
          }),
          adminId: ADMIN_ID,
        },
      });
    }
  });

  log(`Completato: ${plan.length} contratti svincolati.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
