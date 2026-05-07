'use strict';

// src/services/transfermarkt.service.js
// Scraper Transfermarkt per le rose di Serie A
// Richiede: playwright-extra, puppeteer-extra-plugin-stealth
// Installazione: npm install playwright-extra puppeteer-extra-plugin-stealth
//                npx playwright install chromium

// Forza Playwright a cercare i browser in node_modules (compatibile con Render)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

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
  { nome: 'Como',       slug: '/como-1907/kader/verein/1047'           },
  { nome: 'Cremonese',  slug: '/us-cremonese/kader/verein/3898'        },
  { nome: 'Fiorentina', slug: '/acf-fiorentina/kader/verein/430'       },
  { nome: 'Genoa',      slug: '/genua-cfc/kader/verein/252'            },
  { nome: 'Inter',      slug: '/inter-mailand/kader/verein/46'         },
  { nome: 'Juventus',   slug: '/juventus-turin/kader/verein/506'       },
  { nome: 'Lazio',      slug: '/lazio-rom/kader/verein/398'            },
  { nome: 'Lecce',      slug: '/us-lecce/kader/verein/1005'            },
  { nome: 'Milan',      slug: '/ac-mailand/kader/verein/5'             },
  { nome: 'Napoli',     slug: '/ssc-napoli/kader/verein/6195'          },
  { nome: 'Parma',      slug: '/parma-calcio-1913/kader/verein/130'    },
  { nome: 'Pisa',       slug: '/ac-pisa-1909/kader/verein/3446'        },
  { nome: 'Roma',       slug: '/as-rom/kader/verein/12'                },
  { nome: 'Sassuolo',   slug: '/us-sassuolo/kader/verein/6574'         },
  { nome: 'Torino',     slug: '/fc-turin/kader/verein/416'             },
  { nome: 'Udinese',    slug: '/udinese-calcio/kader/verein/410'       },
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
  if (/Mrd/i.test(str))           return Math.round(num * 1000 * 100) / 100;
  if (/Mln|Mio|Mil\./i.test(str)) return Math.round(num * 100) / 100;
  if (/Tsd\.|tsd|Tsd\b/i.test(str) || /\bK\b/i.test(str) || /mila/i.test(str)) return Math.round((num / 1000) * 100) / 100;
  // Valore numerico puro senza unità: se >= 100000 assume sia in euro, converti in milioni
  if (!isNaN(num) && num >= 100000) return Math.round((num / 1_000_000) * 100) / 100;
  return null;
}

/**
 * Normalizza la stringa data di nascita in formato YYYY-MM-DD.
 * Gestisce "Jun 15, 2000 (25)", "15.06.2000 (25)", "15 giu. 2000 (25)".
 */
function parseEta(str) {
  if (!str) return null;
  const m = str.match(/\((\d+)\)/);
  return m ? parseInt(m[1], 10) : null;
}

function normalizeDate(str) {
  if (!str) return null;
  // Rimuovi età tra parentesi: "11/12/2003 (22)" → "11/12/2003"
  const cleaned = str.replace(/\s*\(\d+\)\s*$/, '').trim();

  // Formato dd/mm/yyyy (italiano con slash)
  const slashMatch = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    const [, dd, mm, yyyy] = slashMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  // Formato dd.mm.yyyy (con punto)
  const dotMatch = cleaned.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotMatch) {
    const [, dd, mm, yyyy] = dotMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  // Formato testuale con mesi abbreviati (es. "Dec 11, 2003" o "11 dic 2003")
  const mapped = cleaned
    .replace(/\bgen\b/i, 'Jan').replace(/\bfeb\b/i, 'Feb')
    .replace(/\bmar\b/i, 'Mar').replace(/\bapr\b/i, 'Apr')
    .replace(/\bmag\b/i, 'May').replace(/\bgiu\b/i, 'Jun')
    .replace(/\blug\b/i, 'Jul').replace(/\bago\b/i, 'Aug')
    .replace(/\bset\b/i, 'Sep').replace(/\bott\b/i, 'Oct')
    .replace(/\bnov\b/i, 'Nov').replace(/\bdic\b/i, 'Dec');
  try {
    const d = new Date(mapped);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch { /* ignore */ }
  return cleaned || null;
}

/**
 * Normalizza un ruolo esteso in uno slug (es. "Difensore centrale" → "difensore_centrale").
 */
function slugifyRuolo(r) {
  return (r || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Mappa il ruolo esteso al codice a 1 carattere.
 * Usa prima la mappa DB (ruoliMap), poi fallback regex.
 * @param {string} ruoloEsteso
 * @param {Object|null} ruoliMap - { slug: 'P'|'D'|'C'|'A' }
 */
function mapRuolo(ruoloEsteso, ruoliMap) {
  if (ruoliMap) {
    const slug = slugifyRuolo(ruoloEsteso);
    if (ruoliMap[slug]) return ruoliMap[slug];
  }
  // Fallback regex
  const r = (ruoloEsteso || '').toLowerCase();
  if (/portier|goalkeeper|keeper/.test(r))                             return 'P';
  if (/difensor|defender|back|stopper|libero|terzino/.test(r))        return 'D';
  if (/attacc|forward|striker|punta|ala|winger|seconda|esterno/.test(r)) return 'A';
  return 'C';
}

// ── Scraping singola squadra ─────────────────────────────────────────────────

/**
 * Scrapa la rosa di una squadra.
 * @param {import('playwright').Browser} browser
 * @param {{ nome: string, slug: string }} team
 * @param {Function} onLog
 * @param {Object|null} ruoliMap - mappa { slug → ruolo } da DB
 * @returns {Promise<Array>} array giocatori — lancia eccezione su errore (gestita dal retry wrapper)
 */
async function scrapSquad(browser, team, onLog, ruoliMap = null) {
  const url  = `${BASE_URL}${team.slug}/saison_id/${STAGIONE_ID}/plus/1`;
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

    // Attendi la tabella dei giocatori — se dopo 30s non compare, logga l'URL e lancia errore
    try {
      await page.waitForSelector('table.items', { timeout: 30000 });
    } catch (waitErr) {
      const pageUrl = page.url();
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
      throw new Error(`table.items non trovata (url: ${pageUrl}). Body: ${bodySnippet}`);
    }

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

        // Ruolo esteso: seconda riga dell'inline-table nella cella nome
        let ruoloEsteso = '';
        const nameCell = row.querySelector('td.posrela') || row.querySelector('td.hauptlink');
        if (nameCell) {
          const inlineRows = nameCell.querySelectorAll('.inline-table tr');
          if (inlineRows.length >= 2) {
            ruoloEsteso = (inlineRows[1].textContent || '').trim();
          }
          // Fallback: ruolo come ultimo "token" nel testo della cella, dopo il nome
          if (!ruoloEsteso) {
            const cellText = (nameCell.textContent || '').trim();
            // Il nome appare due volte, poi il ruolo: "Nome Cognome Nome Cognome Ruolo"
            const lines = cellText.split(/\n/).map(s => s.trim()).filter(Boolean);
            if (lines.length >= 2) {
              ruoloEsteso = lines[lines.length - 1];
            }
          }
        }

        // Data di nascita + età: cerca td con una data il cui anno sia ≤ anno corrente
        // (esclude date future come scadenze contratto es. 30/06/2028)
        let dataNasRaw = null;
        let etaRaw     = null;
        const currentYear = new Date().getFullYear();
        const tds = Array.from(row.querySelectorAll('td'));
        for (let i = 0; i < tds.length; i++) {
          const t = tds[i].textContent.trim();

          // Formato dd/mm/yyyy o dd.mm.yyyy — estrai l'anno e validalo
          const numericMatch = t.match(/\b(\d{2})[\/\.](\d{2})[\/\.](\d{4})\b/);
          if (numericMatch) {
            const yr = parseInt(numericMatch[3], 10);
            if (yr >= 1950 && yr <= currentYear) {
              dataNasRaw = t;
              const inlineAge = t.match(/\((\d+)\)/);
              if (inlineAge) {
                etaRaw = inlineAge[1];
              } else if (tds[i + 1]) {
                const nextText = tds[i + 1].textContent.trim();
                const nextAge  = nextText.match(/^\(?(\d{1,2})\)?$/);
                if (nextAge) etaRaw = nextAge[1];
              }
              break;
            }
            continue; // anno fuori range, salta
          }

          // Formato testuale con mese abbreviato + anno 4 cifre
          const textualYearM = t.match(/\b(\d{4})\b/);
          if (
            textualYearM &&
            /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)/i.test(t)
          ) {
            const yr = parseInt(textualYearM[1], 10);
            if (yr >= 1950 && yr <= currentYear) {
              dataNasRaw = t;
              const inlineAge = t.match(/\((\d+)\)/);
              if (inlineAge) etaRaw = inlineAge[1];
              break;
            }
          }
        }

        // Valore di mercato
        const valoreEl  = row.querySelector('td.rechts.hauptlink');
        const valoreStr = valoreEl ? valoreEl.textContent.trim() : null;

        results.push({ transfermarktId, nomeCompleto, ruoloEsteso, dataNasRaw, etaRaw, valoreStr });
      });

      return results;
    });

    const today = new Date();
    const players = rawPlayers.map(p => {
      const dataNascita = normalizeDate(p.dataNasRaw);
      let eta = null;
      if (dataNascita) {
        const nascita = new Date(dataNascita);
        eta = today.getFullYear() - nascita.getFullYear();
        const mDiff = today.getMonth() - nascita.getMonth();
        if (mDiff < 0 || (mDiff === 0 && today.getDate() < nascita.getDate())) eta--;
      }
      return {
        transfermarktId: p.transfermarktId,
        nome:            p.nomeCompleto,
        ruoloEsteso:     p.ruoloEsteso || null,
        ruolo:           mapRuolo(p.ruoloEsteso, ruoliMap),
        dataNascita,
        eta,
        squadra:         team.nome,
        valore:          parseValore(p.valoreStr),
      };
    });

    onLog(`  ✓ ${team.nome}: ${players.length} giocatori trovati`);
    return players;

  } finally {
    await page.close();
  }
}

// ── Retry wrapper ────────────────────────────────────────────────────────────

const RETRY_MAX   = 3;
const RETRY_DELAY = 10_000; // ms

/**
 * Esegue fn() con retry automatico fino a RETRY_MAX tentativi.
 * Attende RETRY_DELAY ms tra un tentativo e l'altro.
 * @param {Function} fn       - funzione asincrona da eseguire
 * @param {string}   label    - nome per i log
 * @param {Function} onLog    - callback log
 * @returns {Promise<*>}      - risultato di fn(), o null se tutti i tentativi falliscono
 */
async function withRetry(fn, label, onLog) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_MAX) {
        onLog(`  ↺ ${label}: tentativo ${attempt}/${RETRY_MAX} fallito (${err.message}). Nuovo tentativo in ${RETRY_DELAY / 1000}s…`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  onLog(`  ✗ ${label}: tutti i ${RETRY_MAX} tentativi falliti. Ultimo errore: ${lastErr.message}`);
  return null;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Scrapa le squadre di Serie A in sequenza.
 * @param {Function} onLog - callback per i log progressivi
 * @param {string[]|null} teamNames - se valorizzato, scrapa solo queste squadre
 * @param {Object|null} ruoliMap - mappa { slug → ruolo } da DB
 * @returns {Promise<Map<string, Array|null>>}
 */
async function scrapeSerieA(onLog = console.log, teamNames = null, ruoliMap = null, teamsCatalog = null) {
  onLog('[TM] Avvio browser stealth…');

  const browser   = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const risultati = new Map();

  const catalog = teamsCatalog || SERIE_A_TEAMS;
  const lista = teamNames && teamNames.length > 0
    ? catalog.filter(t => teamNames.includes(t.nome))
    : catalog;

  try {
    for (const team of lista) {
      onLog(`[TM] Scraping ${team.nome}…`);
      const players = await withRetry(
        () => scrapSquad(browser, team, onLog, ruoliMap),
        team.nome,
        onLog,
      );
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

module.exports = { scrapeSerieA, scrapeSquadFromBrowser: scrapSquad, createBrowser, withRetry, SERIE_A_TEAMS, parseValore, normalizeDate, parseEta, mapRuolo, slugifyRuolo };

async function createBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}
