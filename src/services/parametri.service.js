// src/services/parametri.service.js
// Servizio per leggere i parametri dal DB con cache in-memory.
"use strict";

const prisma = require("../lib/prisma");

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 60 * 1000; // 1 minuto

/**
 * Ritorna tutti i parametri come oggetto { chiave: valore }.
 * I valori numerici vengono convertiti automaticamente.
 */
async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL) return _cache;

  const rows = await prisma.parametro.findMany();
  const map = {};
  for (const r of rows) {
    // Prova a convertire in numero, altrimenti lascia stringa
    const num = Number(r.valore);
    map[r.chiave] = isNaN(num) ? r.valore : num;
  }
  _cache = map;
  _cacheAt = now;
  return map;
}

/**
 * Ritorna un singolo parametro per chiave.
 */
async function get(chiave) {
  const all = await getAll();
  return all[chiave];
}

/**
 * Invalida la cache (dopo un update admin).
 */
function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

// ── Ruoli Transfermarkt ──────────────────────────────────────────────────────

const DEFAULT_RUOLI_TM = [
  { slug: 'portiere',            nome: 'Portiere',            ruolo: 'P' },
  { slug: 'difensore_centrale',  nome: 'Difensore centrale',  ruolo: 'D' },
  { slug: 'terzino_sinistro',    nome: 'Terzino sinistro',    ruolo: 'D' },
  { slug: 'terzino_destro',      nome: 'Terzino destro',      ruolo: 'D' },
  { slug: 'mediano',             nome: 'Mediano',             ruolo: 'C' },
  { slug: 'centrocampista',      nome: 'Centrocampista',      ruolo: 'C' },
  { slug: 'trequartista',        nome: 'Trequartista',        ruolo: 'C' },
  { slug: 'esterno_di_sinistra', nome: 'Esterno di sinistra', ruolo: 'A' },
  { slug: 'esterno_di_destra',   nome: 'Esterno di destra',  ruolo: 'A' },
  { slug: 'ala_sinistra',        nome: 'Ala sinistra',        ruolo: 'A' },
  { slug: 'ala_destra',          nome: 'Ala destra',          ruolo: 'A' },
  { slug: 'seconda_punta',       nome: 'Seconda punta',       ruolo: 'A' },
  { slug: 'punta_centrale',      nome: 'Punta centrale',      ruolo: 'A' },
];

/**
 * Ritorna la mappa { slug → ruolo } per i ruoli Transfermarkt configurati in DB.
 */
async function getRuoliTM() {
  const rows = await prisma.parametro.findMany({
    where: { chiave: { startsWith: 'ruolo_tm_' } },
  });
  const map = {};
  for (const r of rows) {
    const slug = r.chiave.slice('ruolo_tm_'.length);
    map[slug] = r.valore;
  }
  return map;
}

/**
 * Inserisce i ruoli TM predefiniti (non sovrascrive quelli già configurati).
 */
async function initRuoliTM() {
  for (const def of DEFAULT_RUOLI_TM) {
    await prisma.parametro.upsert({
      where:  { chiave: `ruolo_tm_${def.slug}` },
      update: {},   // non sovrascrivere
      create: { chiave: `ruolo_tm_${def.slug}`, valore: def.ruolo, descrizione: def.nome },
    });
  }
  invalidateCache();
}

/**
 * Registra un ruolo TM sconosciuto con valore di default 'C' (se non esiste già).
 */
async function upsertRuoloTM(slug, nome) {
  await prisma.parametro.upsert({
    where:  { chiave: `ruolo_tm_${slug}` },
    update: {},
    create: { chiave: `ruolo_tm_${slug}`, valore: 'C', descrizione: nome },
  });
  invalidateCache();
}

// ── Serie A Teams ────────────────────────────────────────────────────────────

const PARAM_KEY_SERIE_A = 'serie_a_teams';
const PARAM_KEY_CATALOGO = 'serie_a_catalogo';

/**
 * Ritorna l'array di nomi squadre attualmente in Serie A (dal parametro DB).
 * Se non configurato, ritorna null (= usare la lista hardcoded completa).
 */
async function getSerieATeamNames() {
  const row = await prisma.parametro.findUnique({ where: { chiave: PARAM_KEY_SERIE_A } });
  if (!row) return null;
  try {
    return JSON.parse(row.valore);
  } catch {
    return null;
  }
}

/**
 * Salva l'elenco delle squadre di Serie A nel parametro DB.
 */
async function saveSerieATeamNames(teamNames) {
  const valore = JSON.stringify(teamNames);
  await prisma.parametro.upsert({
    where:  { chiave: PARAM_KEY_SERIE_A },
    update: { valore },
    create: { chiave: PARAM_KEY_SERIE_A, valore, descrizione: 'Squadre attualmente in Serie A' },
  });
  invalidateCache();
}

/**
 * Ritorna il catalogo completo delle squadre [{nome, slug}] dal DB.
 * Se non configurato, ritorna null (= usare SERIE_A_TEAMS hardcoded).
 */
async function getSerieACatalogo() {
  const row = await prisma.parametro.findUnique({ where: { chiave: PARAM_KEY_CATALOGO } });
  if (!row) return null;
  try {
    return JSON.parse(row.valore);
  } catch {
    return null;
  }
}

/**
 * Salva il catalogo completo delle squadre nel parametro DB.
 */
async function saveSerieACatalogo(teams) {
  const valore = JSON.stringify(teams);
  await prisma.parametro.upsert({
    where:  { chiave: PARAM_KEY_CATALOGO },
    update: { valore },
    create: { chiave: PARAM_KEY_CATALOGO, valore, descrizione: 'Catalogo completo squadre con slug Transfermarkt' },
  });
  invalidateCache();
}

module.exports = { getAll, get, invalidateCache, getRuoliTM, initRuoliTM, upsertRuoloTM, DEFAULT_RUOLI_TM, getSerieATeamNames, saveSerieATeamNames, getSerieACatalogo, saveSerieACatalogo };
