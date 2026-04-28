// src/services/sheets.service.js
// Legge e analizza il foglio Google Sheets pubblico di Fantapollo 8
// usando l'endpoint gviz/tq (no API key richiesta per fogli pubblici).

const SHEET_ID =
  process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";
const RIEPILOGO_GID = process.env.SHEETS_RIEPILOGO_GID || "1881061782";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuti

// ── cache in-memory ─────────────────────────────────────────────────────────
const _cache = {};

// ── CSV parser ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  return text
    .split("\n")
    .map(l => l.replace(/\r$/, ""))
    .map(parseCSVLine);
}

// ── numero helpers ────────────────────────────────────────────────────────────
function pf(v) { const n = parseFloat((v || "").replace(",", ".")); return isNaN(n) ? 0 : n; }
function pi(v) { const n = parseInt(v);  return isNaN(n) ? 0 : n; }
function t(v)  { return (v || "").trim(); }

// ── parser del foglio Riepilogo ───────────────────────────────────────────────
function parseRiepilogo(rows) {
  const n = rows.length;

  // — individua indici di sezione cercando header-row specifiche —————————————
  let mainHdr = -1, repartiHdr = -1, pmHdr = -1, patrimonioHdr = -1;
  let quotaRinnoviRow = null;

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (!r) continue;
    const a = t(r[0]), b = t(r[1]), c = t(r[2]);

    if (a === "ID" && b === "" && c === "Valore Rose")       mainHdr        = i;
    if (a === "" && b === "" && c === "Giocatori Tesserati")  repartiHdr     = i;
    if (a === "" && /Ultimo Plus.Minus/i.test(b))            pmHdr          = i;
    if (a === "ID" && b === "Andamento Rose")                patrimonioHdr  = i;
    if (/Quota Rinnovi/i.test(b))                            quotaRinnoviRow = r;
  }

  // — presidenti (tabella principale) ──────────────────────────────────────────
  const presidenti = [];
  if (mainHdr >= 0) {
    for (let i = mainHdr + 1; i < n; i++) {
      const r = rows[i];
      if (!r || !t(r[0]).match(/^\d+$/)) continue;
      presidenti.push({
        id:             pi(r[0]),
        nome:           t(r[1]),
        valoreRose:     pf(r[2]),
        crediti:        pf(r[3]),
        patrimonio:     pf(r[4]),
        giocatori:      pi(r[5]),
        etaMedia:       pf(r[6]),
        stipendi:       pf(r[7]),
        montePrestitiIn: pf(r[8]),
        ultimoPM:       pf(r[9]),
      });
    }
  }

  // — reparti (portieri / difensori / centrocampisti / attaccanti) ───────────
  const presNomi = new Set(presidenti.map(p => p.nome));
  const reparti = {};
  if (repartiHdr >= 0) {
    for (let i = repartiHdr + 1; i < n; i++) {
      const r = rows[i];
      const nome = t(r[1]);
      if (!nome || !presNomi.has(nome)) continue;
      reparti[nome] = {
        nome,
        tot:            pi(r[2]),
        portieri:       pi(r[3]),
        difensori:      pi(r[4]),
        centrocampisti: pi(r[5]),
        attaccanti:     pi(r[6]),
      };
    }
  }

  // — quota rinnovi ──────────────────────────────────────────────────────────
  const quotaRinnovi = quotaRinnoviRow ? pf(quotaRinnoviRow[2]) : 0;

  // — storico Plus/Minus ─────────────────────────────────────────────────────
  const pmHdrCols = [];
  const pmHistory  = [];
  if (pmHdr >= 0) {
    const hRow = rows[pmHdr];
    for (let j = 3; j < hRow.length; j++) {
      const h = t(hRow[j]);
      if (h) pmHdrCols.push({ label: h, col: j });
    }
    for (let i = pmHdr + 1; i < n; i++) {
      const r = rows[i];
      const nome = t(r[2]);
      if (!nome || !presNomi.has(nome)) continue;
      pmHistory.push({
        nome,
        ultimoPM: pf(r[1]),
        values:   pmHdrCols.map(({ label, col }) => ({ label, value: pf(r[col]) })),
      });
    }
  }

  // — storico patrimonio ─────────────────────────────────────────────────────
  const patHdrCols = [];
  const patHistory  = [];
  if (patrimonioHdr >= 0) {
    const hRow = rows[patrimonioHdr];
    for (let j = 2; j < hRow.length; j++) {
      const h = t(hRow[j]);
      if (h) patHdrCols.push({ label: h, col: j });
    }
    for (let i = patrimonioHdr + 1; i < n; i++) {
      const r = rows[i];
      if (!t(r[0]).match(/^\d+$/)) continue;
      patHistory.push({
        id:    pi(r[0]),
        nome:  t(r[1]),
        history: patHdrCols.map(({ label, col }) => ({ label, value: pf(r[col]) })),
      });
    }
  }

  return { presidenti, reparti, quotaRinnovi, pmHdrCols, pmHistory, patHdrCols, patHistory };
}

// ── fetch principale con cache ────────────────────────────────────────────────
async function getRiepilogo() {
  const now = Date.now();
  if (_cache.riepilogo && now - _cache.riepilogoAt < CACHE_TTL_MS) {
    return _cache.riepilogo;
  }

  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}` +
    `/gviz/tq?tqx=out:csv&gid=${RIEPILOGO_GID}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossibile caricare il foglio Google (${res.status})`);

  const text  = await res.text();
  const rows  = parseCSV(text);
  const data  = parseRiepilogo(rows);

  _cache.riepilogo   = data;
  _cache.riepilogoAt = now;
  return data;
}

// ── fetch generica per sheet name ─────────────────────────────────────────────
async function fetchSheetByName(sheetName) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}` +
    `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossibile caricare il foglio "${sheetName}" (${res.status})`);
  return parseCSV(await res.text());
}

// ── parser Rose ───────────────────────────────────────────────────────────────
// col0=ruoloEsteso, col1=ruolo(P/D/C/A), col2=nome, col3=squadra,
// col4=stipendio, col5=valoreAcquisto, col6=eta, col7=valoreAggiornato,
// col8=quotPrecedente, col9=dataAcquisto, col10=anniContratto, col11=scadenza
function parseRose(rows) {
  const RUOLI = new Set(["P", "D", "C", "A"]);
  const players = [];
  let section = "rosa";
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const c0 = t(r[0]).toLowerCase();
    if (c0 === "fuorirosa")  { section = "fuorirosa"; continue; }
    if (c0 === "u21")        { section = "u21";       continue; }
    if (!RUOLI.has(t(r[1]))) continue;
    players.push({
      section,
      ruoloEsteso:    t(r[0]),
      ruolo:          t(r[1]),
      nome:           t(r[2]),
      squadra:        t(r[3]),
      stipendio:      pf(r[4]),
      valoreAcquisto: pf(r[5]),
      eta:            t(r[6]),
      valoreAggiornato: pf(r[7]),
      quotPrecedente: pf(r[8]),
      dataAcquisto:   t(r[9]),
      anniContratto:  pi(r[10]),
      scadenza:       t(r[11]),
    });
  }
  return players;
}

// ── parser Finanze ────────────────────────────────────────────────────────────
// Righe 1-10: una per presidente (ordine = ordine Riepilogo per ID)
// col0=vuoto, col1=cassaStipendi, col2=stipendi, col3=creditiAnnoPrecedente,
// col4=acquisti, col5=cessioni, col6=prestitiIn, col7=prestitiOut,
// col8=botteghino, col9=tagli, col10=premiFineAnno, col11=premiGernaio
function parseFinanze(rows, presidenti) {
  const result = [];
  const sorted = [...presidenti].sort((a, b) => a.id - b.id);
  for (let i = 0; i < sorted.length; i++) {
    const r = rows[i + 1]; // skip header
    if (!r) continue;
    result.push({
      nome:               sorted[i].nome,
      cassaStipendi:      pf(r[1]),
      stipendi:           pf(r[2]),
      creditiAnnoPrecendente: pf(r[3]),
      acquisti:           pf(r[4]),
      cessioni:           pf(r[5]),
      prestitiIn:         pf(r[6]),
      prestitiOut:        pf(r[7]),
      botteghino:         pf(r[8]),
      tagli:              pf(r[9]),
      premiFineAnno:      pf(r[10]),
      premiGennaio:       pf(r[11]),
    });
  }
  return result;
}

// ── parser Diario ─────────────────────────────────────────────────────────────
// col0=nome, col1=operazione, col2=da, col3=a, col4=importoAcquisto,
// col5=importoPrestito, col6=riscatto, col7=valoreTM, col8=stipendio, col9=data
function parseDiario(rows) {
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !t(r[0])) continue;
    result.push({
      nome:           t(r[0]),
      operazione:     t(r[1]),
      da:             t(r[2]),
      a:              t(r[3]),
      importoAcquisto: pf(r[4]),
      importoPrestito: pf(r[5]),
      riscatto:       t(r[6]),
      valoreTM:       pf(r[7]),
      stipendio:      pf(r[8]),
      data:           t(r[9]),
    });
  }
  return result;
}

// ── parser Log ────────────────────────────────────────────────────────────────
// col0=data, col1=eventString ([TipoEvento] key=val|key=val|...)
function parseLog(rows) {
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const data = t(r[0]);
    const raw  = t(r[1]);
    if (!raw) continue;
    const match = raw.match(/^\[([^\]]+)\](.*)/);
    if (match) {
      const tipo = match[1];
      const kv   = {};
      match[2].split("|").forEach(pair => {
        const eq = pair.indexOf("=");
        if (eq > 0) kv[pair.substring(0, eq).trim()] = pair.substring(eq + 1).trim();
      });
      result.push({ data, tipo, kv, raw });
    } else {
      result.push({ data, tipo: "info", kv: {}, raw });
    }
  }
  return result.reverse(); // più recente prima
}

// ── getter Rose ───────────────────────────────────────────────────────────────
async function getRose() {
  const now = Date.now();
  if (_cache.rose && now - _cache.roseAt < CACHE_TTL_MS) return _cache.rose;
  const rows = await fetchSheetByName("Rose");
  const data = parseRose(rows);
  _cache.rose = data; _cache.roseAt = now;
  return data;
}

// ── getter Finanze ────────────────────────────────────────────────────────────
async function getFinanze() {
  const now = Date.now();
  if (_cache.finanze && now - _cache.finanzeAt < CACHE_TTL_MS) return _cache.finanze;
  const [rows, riep] = await Promise.all([fetchSheetByName("Finanze"), getRiepilogo()]);
  const data = parseFinanze(rows, riep.presidenti);
  _cache.finanze = data; _cache.finanzeAt = now;
  return data;
}

// ── getter Diario ─────────────────────────────────────────────────────────────
async function getDiario() {
  const now = Date.now();
  if (_cache.diario && now - _cache.diarioAt < CACHE_TTL_MS) return _cache.diario;
  const rows = await fetchSheetByName("Diario");
  const data = parseDiario(rows);
  _cache.diario = data; _cache.diarioAt = now;
  return data;
}

// ── builder Giocatori (roster correnti da Diario) ─────────────────────────────
// Parsa il Diario e ricostruisce i roster correnti per presidente.
// Regole:
//   Acquisto / Riscatto  (a = presidente) → giocatore appartiene a quel presidente
//   Cessione             (a = Libero)     → giocatore liberato (fuori rosa)
//   Cessione             (a = presidente) → trasferimento a nuovo presidente
//   Taglio                                → giocatore tagliato (fuori rosa)
function buildGiocatori(diario) {
  function parseDate(s) {
    if (!s) return 0;
    const parts = s.split("/");
    if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
    return 0;
  }

  // ordina dal più vecchio al più recente
  const sorted = [...diario].sort((a, b) => parseDate(a.data) - parseDate(b.data));

  const state = new Map(); // nome → record corrente

  for (const op of sorted) {
    const nome = op.nome;
    if (!nome) continue;
    const tipo = (op.operazione || "").toLowerCase();

    if (tipo.includes("acquisto") || tipo.includes("riscatto")) {
      const presidente = op.a;
      if (presidente && presidente !== "Libero") {
        state.set(nome, {
          nome,
          presidente,
          dataAcquisto:   op.data,
          importoAcquisto: op.importoAcquisto,
          importoPrestito: op.importoPrestito,
          stipendio:      op.stipendio,
          valoreTM:       op.valoreTM,
          operazione:     op.operazione,
          active:         true,
        });
      }
    } else if (tipo.includes("cessione")) {
      const existing = state.get(nome);
      if (existing) {
        if (!op.a || op.a === "Libero") {
          // liberato
          state.set(nome, { ...existing, active: false, presidente: null });
        } else {
          // trasferito a nuovo presidente
          state.set(nome, { ...existing, presidente: op.a, active: true });
        }
      }
    } else if (tipo.includes("taglio")) {
      const existing = state.get(nome);
      if (existing) state.set(nome, { ...existing, active: false, presidente: null });
    }
  }

  // solo giocatori attivi, raggruppati per presidente
  const attivi = [...state.values()].filter(p => p.active && p.presidente);
  attivi.sort((a, b) => a.presidente.localeCompare(b.presidente) || a.nome.localeCompare(b.nome));
  return attivi;
}

// ── getter Giocatori ──────────────────────────────────────────────────────────
async function getGiocatori() {
  const now = Date.now();
  if (_cache.giocatori && now - _cache.giocatoriAt < CACHE_TTL_MS) return _cache.giocatori;
  const diario = await getDiario();
  const data = buildGiocatori(diario);
  _cache.giocatori = data; _cache.giocatoriAt = now;
  return data;
}

// ── getter Log ────────────────────────────────────────────────────────────────
async function getLog() {
  const now = Date.now();
  if (_cache.log && now - _cache.logAt < CACHE_TTL_MS) return _cache.log;
  const rows = await fetchSheetByName("Log");
  const data = parseLog(rows);
  _cache.log = data; _cache.logAt = now;
  return data;
}

// ── invalidazione manuale della cache ────────────────────────────────────────
function invalidateCache() {
  delete _cache.riepilogo;  delete _cache.riepilogoAt;
  delete _cache.rose;       delete _cache.roseAt;
  delete _cache.finanze;    delete _cache.finanzeAt;
  delete _cache.diario;     delete _cache.diarioAt;
  delete _cache.giocatori;  delete _cache.giocatoriAt;
  delete _cache.log;        delete _cache.logAt;
}

module.exports = { getRiepilogo, getFinanze, getDiario, getGiocatori, getLog, invalidateCache };
