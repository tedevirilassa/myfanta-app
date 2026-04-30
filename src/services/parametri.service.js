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

module.exports = { getAll, get, invalidateCache };
