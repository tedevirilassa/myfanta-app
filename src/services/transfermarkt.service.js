'use strict';

// src/services/transfermarkt.service.js
// Scraper Transfermarkt per le rose di Serie A
// Richiede: playwright-extra, puppeteer-extra-plugin-stealth
// Installazione: npm install playwright-extra puppeteer-extra-plugin-stealth
//                npx playwright install chromium

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

// ── Stagione corrente ────────────────────────────────────────────────────────
const STAGIONE_ID = '2025'; // saison_id per 2025/2026
const BASE_URL    = 'https://www.transfermarkt.it';

// ── Rosa Serie A 2025/2026 ───────────────────────────────────────────────────
const SERIE_A_TEAMS = [
  { nome: 'Atalanta',   slug: '/atalanta-bergamo/kader/verein/800'     },
  { nome: 'Bologna',    slug: '/fc-bologna/kader/verein/1025'          },
  { nome: 'Cagliari',   slug: '/cagliari-calcio/kader/verein/1390'     },
  { nome: 'Como',       slug: '/como-1907/kader/verein/2479'           },
  { nome: 'Empoli',     slug: '/fc-empoli/kader/verein/749'            },
  { nome: 'Fiorentina', slug: '/acf-fiorentina/kader/verein/430'       },
  { nome: 'Genoa',      slug: '/genua-cfc/kader/verein/252'            },
  { nome: 'Inter',      slug: '/inter-mailand/kader/verein/46'         },
  { nome: 'Juventus',   slug: '/juventus-turin/kader/verein/506'       },
  { nome: 'Lazio',      slug: '/lazio-rom/kader/verein/398'            },
  { nome: 'Lecce',      slug: '/us-lecce/kader/verein/1963'            },
  { nome: 'Milan',      slug: '/ac-mailand/kader/verein/5'             },
  { nome: 'Monza',      slug: '/ac-monza/kader/verein/2919'            },
  { nome: 'Napoli',     slug: '/ssc-napoli/kader/verein/6195'          },
  { nome: 'Parma',      slug: '/parma-calcio-1913/kader/verein/143'    },
  { nome: 'Roma',       slug: '/as-rom/kader/verein/12'                },
  { nome: 'Torino',     slug: '/fc-turin/kader/verein/416'             },
  { nome: 'Udinese',    slug: '/udinese-calcio/kader/verein/410'       },
  { nome: 'Venezia',    slug: '/fc-venezia/kader/verein/496'           },
  { nome: 'Verona',     slug: '/hellas-verona/kader/verein/276'        },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Converte il testo del valore di mercato Transfermarkt in float (milioni).
 * "€ 25,00 Mln" → 25.0  |  "€ 1,00 Mrd." → 1000.0  |  "€ 500 Tsd." → 0.5
 */
function parseValore(str) {
  if (!str || str.trim() === '-') return null;
  const cleaned = str.replace(/[€\s\u00a0]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  if (/Mrd/i.test(str)) return Math.round(num * 1000 * 100) / 100;
  if (/Mln|Mio|Mil\./i.test(str)) return Math.round(num * 100) / 100;
  if (/Tsd\./i.test(str)) return Math.round((num / 1000) * 100) / 100;
  return null;
}

/**
 * Normalizza la stringa data di nascita in formato YYYY-MM-DD.
 * Gestisce "Jun 15, 2000 (25)", "15.06.2000 (25)", "15 giu. 2000 (25)".
 */
function normalizeDate(str) {
  if (!str) return null;
  // Rimuovi età tra parentesi
  const cleaned = str.replace(/\s*\(\d+\)\s*$/, '').trim();
  // Sostituisci abbreviazioni italiane con inglesi per parsing
  const mapped = cleaned
    .replace(/\bgen\b/i, 'Jan').replace(/\bfeb\b/i, 'Feb')
    .replace(/\bmar\b/i, 'Mar').replace(/\bapr\b/i, 'Apr')
    .replace(/\bmag\b/i, 'May').replace(/\bgiu\b/i, 'Jun')
    .replace(/\blug\b/i, 'Jul').replace(/\bago\b/i, 'Aug')
    .replace(/\bset\b/i, 'Sep').replace(/\bott\b/i, 'Oct')
    .replace(/\bnov\b/i, 'Nov').replace(/\bdic\b/i, 'Dec')
    .replace(/\./g, ' ');
  try {
    const d = new Date(mapped);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch { /* ignore */ }
  return cleaned || null;
}

/**
 * Mappa il ruolo esteso (IT/EN) al codice a 1 carattere.
 */
function mapRuolo(ruoloEsteso) {
  const r = (ruoloEsteso || '').toLowerCase();
  if (/portier|goalkeeper|keeper/.test(r))                    return 'P';
  if (/difensor|defender|back|stopper|libero/.test(r))        return 'D';
  if (/attacc|forward|striker|punta|ala|winger|seconda/.test(r)) return 'A';
  return 'C';
}

// ── Scraping singola squadra ─────────────────────────────────────────────────

/**
 * Scrapa la rosa di una squadra.
 * @param {import('playwright').Browser} browser
 * @param {{ nome: string, slug: string }} team
 * @param {Function} onLog
 * @returns {Promise<Array|null>} array giocatori o null se errore
 */
async function scrapSquad(browser, team, onLog) {
  const url  = `${BASE_URL}${team.slug}/saison_id/${STAGIONE_ID}`;
  const page = await browser.newPage();

  try {
    // Header realistici
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Cookie consent (OneTrust) — ignora il timeout se non compare
    try {
      await page.locator('#onetrust-accept-btn-handler').click({ timeout: 6000 });
      await page.waitForTimeout(900);
    } catch { /* banner assente */ }

    // Attendi la tabella dei giocatori
    await page.waitForSelector('table.items', { timeout: 20000 });

    // Estrai tutti i dati in un unico evaluate per efficienza
    const rawPlayers = await page.evaluate(() => {
      const rows    = Array.from(document.querySelectorAll('table.items > tbody > tr'));
      const results = [];

      rows.forEach(row => {
        // Salta righe separatori/intestazioni
        if (row.classList.contains('extrarow')) return;

        // Link profilo → trasfermarktId + nome
        const profileLink = row.querySelector('a[href*="/profil/spieler/"]');
        if (!profileLink) return;

        const href       = profileLink.getAttribute('href') || '';
        const tmIdMatch  = href.match(/\/spieler\/(\d+)/);
        if (!tmIdMatch) return;

        const transfermarktId = tmIdMatch[1];
        const nomeCompleto    = (profileLink.textContent || '').trim();
        if (!nomeCompleto) return;

        // Ruolo: seconda riga nell'inline-table della cella nome
        let ruoloEsteso = '';
        const inlineRows = row.querySelectorAll('.inline-table tr');
        if (inlineRows.length >= 2) {
          ruoloEsteso = (inlineRows[1].textContent || '').trim();
        }

        // Data di nascita: cerca td con anno a 4 cifre + nome mese
        let dataNasRaw = null;
        const tds = Array.from(row.querySelectorAll('td'));
        for (const td of tds) {
          const t = td.textContent.trim();
          if (
            /\b\d{4}\b/.test(t) &&
            (
              /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)/i.test(t) ||
              /\d{2}\.\d{2}\.\d{4}/.test(t)
            )
          ) {
            dataNasRaw = t;
            break;
          }
        }

        // Nazionalità: prima flag con titolo
        let nazionalita = null;
        const flagImgs  = row.querySelectorAll('td.zentriert img[title]');
        if (flagImgs.length > 0) {
          nazionalita = flagImgs[0].getAttribute('title');
        }

        // Valore di mercato
        const valoreEl  = row.querySelector('td.rechts.hauptlink');
        const valoreStr = valoreEl ? valoreEl.textContent.trim() : null;

        results.push({ transfermarktId, nomeCompleto, ruoloEsteso, dataNasRaw, nazionalita, valoreStr });
      });

      return results;
    });

    const players = rawPlayers.map(p => ({
      transfermarktId: p.transfermarktId,
      nome:            p.nomeCompleto,
      ruoloEsteso:     p.ruoloEsteso || null,
      ruolo:           mapRuolo(p.ruoloEsteso),
      dataNascita:     normalizeDate(p.dataNasRaw),
      nazionalita:     p.nazionalita || null,
      squadra:         team.nome,
      valore:          parseValore(p.valoreStr),
    }));

    onLog(`  ✓ ${team.nome}: ${players.length} giocatori trovati`);
    return players;

  } catch (err) {
    onLog(`  ✗ ${team.nome}: errore – ${err.message}`);
    return null; // null segnala errore su questa squadra
  } finally {
    await page.close();
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Scrapa tutte le squadre di Serie A in sequenza.
 * @param {Function} onLog - callback per i log progressivi
 * @returns {Promise<Map<string, Array|null>>} mappa teamNome → giocatori (null = errore)
 */
async function scrapeSerieA(onLog = console.log) {
  onLog('[TM] Avvio browser stealth…');

  const browser   = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const risultati = new Map();

  try {
    for (const team of SERIE_A_TEAMS) {
      onLog(`[TM] Scraping ${team.nome}…`);
      const players = await scrapSquad(browser, team, onLog);
      risultati.set(team.nome, players);
      // Delay anti-bot: 2–4 secondi random
      const delay = 2000 + Math.floor(Math.random() * 2000);
      await new Promise(r => setTimeout(r, delay));
    }
  } finally {
    await browser.close();
    onLog('[TM] Browser chiuso.');
  }

  return risultati;
}

module.exports = { scrapeSerieA, scrapeSquadFromBrowser: scrapSquad, createBrowser, SERIE_A_TEAMS, parseValore, normalizeDate, mapRuolo };

async function createBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}
