'use strict';

// src/services/sync-quotazioni.service.js
// Orchestrazione dello scraping Transfermarkt + upsert DB

const prisma               = require('../lib/prisma');
const { scrapeSerieA }     = require('./transfermarkt.service');

const STAGIONE_CORRENTE = '2025-2026';

// ── Normalizzazione nome per matching ────────────────────────────────────────

/**
 * Rimuove diacritici e caratteri speciali per il matching by-nome.
 * "Lautaró Martínez" → "lautaro martinez"
 */
function normalizeName(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

// ── Sync principale ──────────────────────────────────────────────────────────

/**
 * Esegue il ciclo completo: scraping → upsert giocatori → storico quotazioni
 * → marcatura inattivi.
 *
 * @param {Function} onEvent - callback per eventi SSE { type, msg, stats? }
 * @returns {Promise<object>} statistiche finali
 */
async function syncQuotazioni(onEvent = console.log) {
  const stats = {
    squadreOk:  0,
    squadreKo:  0,
    aggiornati: 0,
    nuovi:      0,
    inattivi:   0,
    erroriRiga: 0,
  };

  // ── 1. Scraping ─────────────────────────────────────────────────────────
  onEvent({ type: 'info', msg: '🚀 Avvio scraping Transfermarkt…' });

  const risultati = await scrapeSerieA((msg) => onEvent({ type: 'log', msg }));

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
        let existing = null;

        // A) Match per transfermarktId (più affidabile)
        if (g.transfermarktId) {
          existing = await prisma.giocatore.findFirst({
            where: { transfermarktId: g.transfermarktId },
          });
        }

        // B) Fallback: match per nome normalizzato nella stessa squadra
        if (!existing) {
          const nomeNorm   = normalizeName(g.nome);
          const candidates = await prisma.giocatore.findMany({
            where:  { squadra: teamNome },
            select: { id: true, nome: true, transfermarktId: true },
          });
          const match = candidates.find(c => normalizeName(c.nome) === nomeNorm);
          if (match) existing = match;
        }

        if (existing) {
          // ── Aggiorna giocatore esistente ──────────────────────────────
          await prisma.giocatore.update({
            where: { id: existing.id },
            data: {
              squadra:         g.squadra,
              valore:          g.valore,
              active:          true,
              ...(g.ruoloEsteso    && { ruoloEsteso: g.ruoloEsteso }),
              ...(g.ruolo         && { ruolo: g.ruolo }),
              ...(g.dataNascita   && { dataNascita: g.dataNascita }),
              ...(g.nazionalita   && { nazionalita: g.nazionalita }),
              ...(g.transfermarktId && { transfermarktId: g.transfermarktId }),
            },
          });

          // Storico quotazione
          await prisma.quotazione.create({
            data: {
              giocatoreId: existing.id,
              valore:      g.valore,
              fonte:       'transfermarkt',
              stagione:    STAGIONE_CORRENTE,
            },
          });

          idScrapati.add(existing.id);
          stats.aggiornati++;

        } else {
          // ── Crea nuovo giocatore + prima quotazione ───────────────────
          const nuovo = await prisma.giocatore.create({
            data: {
              nome:            g.nome,
              ruolo:           g.ruolo || 'C',
              ruoloEsteso:     g.ruoloEsteso   || null,
              squadra:         g.squadra,
              valore:          g.valore,
              dataNascita:     g.dataNascita   || null,
              nazionalita:     g.nazionalita   || null,
              transfermarktId: g.transfermarktId || null,
              active:          true,
            },
          });

          await prisma.quotazione.create({
            data: {
              giocatoreId: nuovo.id,
              valore:      g.valore,
              fonte:       'transfermarkt',
              stagione:    STAGIONE_CORRENTE,
            },
          });

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
