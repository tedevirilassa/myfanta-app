'use strict';

// src/services/sync-quotazioni.service.js
// Orchestrazione dello scraping Transfermarkt + upsert DB

const prisma               = require('../lib/prisma');
const { scrapeSerieA }     = require('./transfermarkt.service');
const parametriService     = require('./parametri.service');
const { logAction }        = require('./log.service');

// Stagione calcolata dinamicamente dal parametro stagione_inizio.
function getStagioneCorrente(params) {
  const stagioneInizio = params.stagione_inizio || '01-07';
  const meseInizio = parseInt(stagioneInizio.split('-')[1], 10) || 7;
  const oggi = new Date();
  const meseOggi = oggi.getMonth() + 1;
  const anno = meseOggi >= meseInizio ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return `${anno}-${anno + 1}`;
}

// ── Normalizzazione nome per matching ────────────────────────────────────────

/**
 * Rimuove diacritici e caratteri speciali per il matching by-nome.
 * "Lautaró Martínez" → "lautaro martinez"
 */
// Normalizza il nome: lowercase, strip accenti + lettere latine estese
// (\u00d8\u2192o, \u0131\u2192i, \u0142\u2192l, \u00e6\u2192ae\u2026), separatori non-alfanumerici \u2192 spazi, collassa.
const EXTRA_NORM = {"\u00d8":"O","\u00f8":"o","\u0141":"L","\u0142":"l","\u0110":"D","\u0111":"d","\u00c6":"AE","\u00e6":"ae","\u0152":"OE","\u0153":"oe","\u0131":"i","\u0130":"I","\u00df":"ss","\u00de":"Th","\u00fe":"th"};
function normalizeName(str) {
  if (!str) return '';
  let out = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  out = out.replace(/[\u00d8\u00f8\u0141\u0142\u0110\u0111\u00c6\u00e6\u0152\u0153\u0131\u0130\u00df\u00de\u00fe]/g, (ch) => EXTRA_NORM[ch] || ch);
  return out.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Sync principale ──────────────────────────────────────────────────────────

/**
 * Esegue il ciclo completo: scraping → upsert giocatori → storico quotazioni
 * → marcatura inattivi.
 *
 * @param {Function} onEvent  - callback per eventi SSE { type, msg, stats? }
 * @param {string|null} squadraFiltro - se valorizzato, scrapa solo questa squadra
 * @returns {Promise<object>} statistiche finali
 */
async function syncQuotazioni(onEvent = console.log, squadraFiltro = null, adminId = null) {
  const stats = {
    squadreOk:  0,
    squadreKo:  0,
    aggiornati: 0,
    nuovi:      0,
    inattivi:   0,
    erroriRiga: 0,
  };

  // ── 1. Scraping ─────────────────────────────────────────────────────────
  const label = squadraFiltro ? squadraFiltro : 'tutte le squadre';
  onEvent({ type: 'info', msg: `🚀 Avvio scraping Transfermarkt (${label})…` });

  // Usa le squadre attive configurate nei parametri (se non c'è filtro specifico)
  let teamNames = squadraFiltro ? [squadraFiltro] : await parametriService.getSerieATeamNames();
  const catalogo = await parametriService.getSerieACatalogo();
  const ruoliMap  = await parametriService.getRuoliTM();
  const risultati = await scrapeSerieA((msg) => onEvent({ type: 'log', msg }), teamNames, ruoliMap, catalogo);

  // Stagione corrente dinamica (da parametro)
  const _params = await parametriService.getAll();
  const STAGIONE_CORRENTE = getStagioneCorrente(_params);

  // ── 2. Elaborazione per squadra ─────────────────────────────────────────
  for (const [teamNome, giocatori] of risultati.entries()) {
    if (giocatori === null) {
      stats.squadreKo++;
      onEvent({ type: 'warn', msg: `⚠ Squadra ${teamNome} saltata (errore scraping)` });
      continue;
    }

    onEvent({ type: 'info', msg: `📋 Elaborazione ${teamNome} (${giocatori.length} giocatori)…` });

    // Mappa id → true per i giocatori trovati oggi in questa squadra
    const idScrapati = new Set();

    for (const g of giocatori) {
      try {
        // Match SOLO per nome normalizzato sull'intero DB (no transfermarktId,
        // no filtro squadra): un giocatore che cambia squadra resta lo stesso
        // record → evita duplicati post-trasferimento.
        const nomeNorm = normalizeName(g.nome);
        const candidates = await prisma.giocatore.findMany({
          select: { id: true, nome: true },
        });
        const existing = candidates.find((c) => normalizeName(c.nome) === nomeNorm) || null;

        if (existing) {
          // ── Aggiorna giocatore esistente ──────────────────────────────
          // Nota: transfermarktId NON viene più scritto.
          const updateData = {
            squadra:         g.squadra,
            valore:          g.valore,
            active:          true,
            ...(g.ruoloEsteso    && { ruoloEsteso: g.ruoloEsteso }),
            ...(g.ruolo         && { ruolo: g.ruolo }),
            ...(g.dataNascita   && { dataNascita: g.dataNascita }),
            ...(g.eta != null    && { eta: g.eta }),
          };
          await prisma.giocatore.update({ where: { id: existing.id }, data: updateData });

          // Storico quotazione
          await prisma.quotazione.create({
            data: {
              giocatoreId: existing.id,
              valore:      g.valore,
              fonte:       'transfermarkt',
            },
          });

          if (adminId) await logAction({ azione: 'UPDATE', entita: 'giocatore', entitaId: existing.id, dettaglio: { dopo: updateData }, adminId });

          idScrapati.add(existing.id);
          stats.aggiornati++;

        } else {
          // ── Crea nuovo giocatore + prima quotazione ───────────────────
          // Nota: transfermarktId NON viene più scritto.
          const nuovo = await prisma.giocatore.create({
            data: {
              nome:            g.nome,
              ruolo:           g.ruolo || 'C',
              ruoloEsteso:     g.ruoloEsteso   || null,
              squadra:         g.squadra,
              valore:          g.valore,
              dataNascita:     g.dataNascita   || null,
              eta:             g.eta           ?? null,
              active:          true,
            },
          });

          await prisma.quotazione.create({
            data: {
              giocatoreId: nuovo.id,
              valore:      g.valore,
              fonte:       'transfermarkt',
            },
          });

          if (adminId) await logAction({ azione: 'CREATE', entita: 'giocatore', entitaId: nuovo.id, dettaglio: { dopo: { nome: g.nome, ruolo: g.ruolo, squadra: g.squadra, valore: g.valore } }, adminId });

          idScrapati.add(nuovo.id);
          stats.nuovi++;
        }

      } catch (err) {
        stats.erroriRiga++;
        onEvent({ type: 'warn', msg: `  ✗ "${g.nome}" (${teamNome}): ${err.message}` });
      }
    }

    // ── 3. Marca inattivi: giocatori in DB per questa squadra non trovati oggi
    const attivi = await prisma.giocatore.findMany({
      where:  { squadra: teamNome, active: true },
      select: { id: true, nome: true },
    });

    const daInattivare = attivi.filter(g => !idScrapati.has(g.id));
    if (daInattivare.length > 0) {
      await prisma.giocatore.updateMany({
        where: { id: { in: daInattivare.map(g => g.id) } },
        data:  { active: false },
      });
      if (adminId) {
        for (const gi of daInattivare) {
          await logAction({ azione: 'UPDATE', entita: 'giocatore', entitaId: gi.id, dettaglio: { prima: { active: true }, dopo: { active: false } }, adminId });
        }
      }
      stats.inattivi += daInattivare.length;
      onEvent({
        type: 'warn',
        msg:  `  ↓ ${teamNome}: ${daInattivare.length} inattivati (${daInattivare.map(g => g.nome).join(', ')})`,
      });
    }

    stats.squadreOk++;
    onEvent({ type: 'success', msg: `✅ ${teamNome}: +${giocatori.length} quote salvate` });
  }

  return stats;
}

module.exports = { syncQuotazioni };
