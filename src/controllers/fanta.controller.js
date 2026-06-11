// src/controllers/fanta.controller.js
const sheets = require("../services/sheets.service");
const prisma  = require("../lib/prisma");
const parametriService = require("../services/parametri.service");
const { getRemainingContractYears } = require("../utils/contractUtils");

async function showClassifica(req, res) {
  try {
    const params = await parametriService.getAll();
    const rawRecords = await prisma.situazioneFinanziaria.findMany({
      orderBy: { patrimonio: "desc" },
      include: {
        fantaTeam: {
          include: {
            contratti: {
              where: { valido: true },
              include: { giocatore: { select: { id: true, valore: true, eta: true } } },
            },
          },
        },
      },
    });

    // Calcola statistiche dinamicamente dai contratti validi per ogni record SF
    const classifica = rawRecords.map((p) => {
      const contratti = p.fantaTeam?.contratti ?? [];

      // Deduplicazione: un giocatore con più contratti validi conta una volta
      const seen = new Set();
      let valoreRose = 0, stipendi = 0, montePrestiti = 0;
      let etaSomma = 0, etaCount = 0;

      for (const c of contratti) {
        if (seen.has(c.giocatore.id)) continue;
        seen.add(c.giocatore.id);

        if (c.tipo === "Acquisto") {
          valoreRose += c.giocatore.valore ? +c.giocatore.valore : 0;
          stipendi   += c.importoOperazione ? +c.importoOperazione : 0;
        } else if (c.tipo === "Prestito") {
          montePrestiti += c.importoOperazione ? +c.importoOperazione : 0;
        }

        if (c.giocatore.eta != null) {
          etaSomma += c.giocatore.eta;
          etaCount++;
        }
      }

      const giocatoriTesserati = seen.size;
      const etaMedia = etaCount > 0 ? Math.round((etaSomma / etaCount) * 100) / 100 : 0;
      const crediti  = +p.crediti;
      valoreRose     = Math.round(valoreRose * 100) / 100;
      stipendi       = Math.round(stipendi * 100) / 100;
      montePrestiti  = Math.round(montePrestiti * 100) / 100;
      const patrimonio = Math.round((valoreRose + crediti) * 100) / 100;

      return {
        ...p,
        valoreRose,
        crediti,
        patrimonio,
        giocatoriTesserati,
        etaMedia,
        stipendi,
        montePrestiti,
        ultimoPlusMinus: +p.ultimoPlusMinus,
      };
    });

    // Riordina per patrimonio ricalcolato
    classifica.sort((a, b) => b.patrimonio - a.patrimonio);

    // Lista team per combobox admin
    const teamsPerCombobox = classifica
      .filter((p) => p.fantaTeam?.id)
      .map((p) => ({ id: p.fantaTeam.id, nome: p.fantaTeam.nome, nomePresidente: p.nomePresidente }))
      .sort((a, b) => a.nome.localeCompare(b.nome));

    // ── Admin: dettaglio rosa per team ──────────────────────────────────────
    let teamDetail = null;
    if (req.user && req.user.role === "ADMIN" && req.query.teamDetail) {
      const tid = parseInt(req.query.teamDetail, 10);
      if (Number.isFinite(tid)) {
        const teamInfo = await prisma.fantaTeam.findUnique({
          where: { id: tid }, include: { user: true },
        });
        const contratti = await prisma.contratto.findMany({
          where: { fantaTeamId: tid, valido: true, tipo: "Acquisto" },
          include: { giocatore: { select: { id: true, nome: true, ruolo: true, squadra: true, valore: true, active: true, eta: true } } },
          orderBy: [{ giocatore: { ruolo: "asc" } }, { giocatore: { nome: "asc" } }],
        });
        const seen = new Set();
        const giocatoriDett = [];
        let totale = 0;
        for (const c of contratti) {
          if (seen.has(c.giocatore.id)) continue;
          seen.add(c.giocatore.id);
          const val = c.giocatore.valore ? Number(c.giocatore.valore) : 0;
          totale += val;
          giocatoriDett.push({
            id:        c.giocatore.id,
            nome:      c.giocatore.nome,
            ruolo:     c.giocatore.ruolo,
            squadra:   c.giocatore.squadra,
            eta:       c.giocatore.eta,
            valore:    val,
            stipendio: c.importoOperazione ? Number(c.importoOperazione) : 0,
            active:    c.giocatore.active,
            contrattoId: c.id,
          });
        }
        giocatoriDett.sort((a, b) => a.nome.localeCompare(b.nome, "it", { sensitivity: "base" }));
        teamDetail = {
          team: teamInfo,
          giocatori: giocatoriDett,
          totaleValore: Math.round(totale * 100) / 100,
        };
      }
    }

    res.render("fanta/classifica", {
      classifica,
      currentUser: req.user,
      teamsPerCombobox,
      teamDetail,
      salaryCapPct: parseFloat(params.rinnovi_salary_cap_pct || "0.25"),
      error: null,
    });
  } catch (err) {
    console.error("showClassifica error:", err.message);
    res.render("fanta/classifica", {
      classifica: [],
      currentUser: req.user,
      teamsPerCombobox: [],
      teamDetail: null,
      error: "Errore nel caricamento dei dati: " + err.message,
    });
  }
}

async function showRiepilogo(req, res) {
  try {
    const data = await sheets.getRiepilogo();
    // Override quotaRinnovi con calcolo live da DB (la versione da Sheets è
    // statica). Stessa formula di /fanta/classifica: (max+min)/2 * 25%.
    try {
      const live = await calcQuotaRinnoviLive();
      if (live != null) data.quotaRinnovi = live;
    } catch (e) { /* fallback: mantieni quotaRinnovi da sheet */ }
    res.render("fanta/riepilogo", { ...data, currentUser: req.user, error: null });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.render("fanta/riepilogo", {
      presidenti: [], reparti: {}, quotaRinnovi: 0,
      pmHdrCols: [], pmHistory: [], patHdrCols: [], patHistory: [],
      currentUser: req.user, error: err.message,
    });
  }
}

// Calcola quotaRinnovi = (max + min)/2 * 25% sulle rose live della stagione
// corrente. Stessa logica usata da showClassifica.
async function calcQuotaRinnoviLive() {
  const params = await parametriService.getAll();
  const sfs = await prisma.situazioneFinanziaria.findMany({});
  if (sfs.length === 0) return null;

  const users = await prisma.user.findMany({
    where:  { fantaTeam: { isNot: null } },
    select: { nickname: true, email: true, fantaTeam: { select: { id: true } } },
  });
  const norm = (s) => (s || "").trim().toLowerCase();
  const isValid = (n) => n && norm(n) !== "null" && norm(n) !== "";
  function resolveTeamId(nomePresidente) {
    const nN = norm(nomePresidente);
    if (!nN) return null;
    for (const u of users) if (isValid(u.nickname) && norm(u.nickname) === nN) return u.fantaTeam.id;
    for (const u of users) if (u.email && norm(u.email.split("@")[0]) === nN) return u.fantaTeam.id;
    for (const u of users) if (u.email && norm(u.email).includes(nN)) return u.fantaTeam.id;
    return null;
  }

  const valori = [];
  for (const s of sfs) {
    const tid = s.fantaTeamId || resolveTeamId(s.nomePresidente);
    let valore;
    if (tid) {
      const contratti = await prisma.contratto.findMany({
        where: { fantaTeamId: tid, valido: true, tipo: "Acquisto" },
        include: { giocatore: { select: { id: true, valore: true } } },
      });
      const seen = new Set();
      let rosa = 0;
      for (const c of contratti) {
        if (seen.has(c.giocatoreId)) continue;
        seen.add(c.giocatoreId);
        rosa += c.giocatore.valore ? Number(c.giocatore.valore) : 0;
      }
      valore = Math.round(rosa * 100) / 100;
    } else {
      valore = Number(s.valoreRose);
    }
    valori.push(valore);
  }
  const max = Math.max(...valori);
  const min = Math.min(...valori);
  const salaryCapPct = parseFloat(params.rinnovi_salary_cap_pct || "0.25");
  return Math.round(((max + min) / 2) * salaryCapPct * 100) / 100;
}

async function showPresidente(req, res) {
  try {
    const { nome } = req.params;
    const data = await sheets.getRiepilogo();
    const presidente = data.presidenti.find(
      p => p.nome.toLowerCase() === nome.toLowerCase()
    );
    if (!presidente) return res.redirect("/fanta/classifica");

    const reparto = data.reparti[presidente.nome] || null;
    const pm      = data.pmHistory.find(p => p.nome === presidente.nome) || null;
    const pat     = data.patHistory.find(p => p.nome === presidente.nome) || null;

    res.render("fanta/presidente", {
      presidente, reparto, pm, pat,
      pmHdrCols: data.pmHdrCols,
      currentUser: req.user, error: null,
    });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.redirect("/fanta/classifica");
  }
}

async function showRose(req, res) {
  try {
    const players = await sheets.getRose();
    res.render("fanta/rose", { players, currentUser: req.user, error: null });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.render("fanta/rose", { players: [], currentUser: req.user, error: err.message });
  }
}

async function showFinanze(req, res) {
  try {
    const finanze = await sheets.getFinanze();
    res.render("fanta/finanze", { finanze, currentUser: req.user, error: null });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.render("fanta/finanze", { finanze: [], currentUser: req.user, error: err.message });
  }
}

async function showDiario(req, res) {
  try {
    const diario = await sheets.getDiario();
    res.render("fanta/diario", { diario, currentUser: req.user, error: null });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.render("fanta/diario", { diario: [], currentUser: req.user, error: err.message });
  }
}

async function showLog(req, res) {
  try {
    const logs = await sheets.getLog();
    res.render("fanta/log", { logs, currentUser: req.user, error: null });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.render("fanta/log", { logs: [], currentUser: req.user, error: err.message });
  }
}

async function showGiocatori(req, res) {
  try {
    const giocatori = await sheets.getGiocatori();
    // raggruppa per presidente
    const byPresidente = {};
    for (const g of giocatori) {
      if (!byPresidente[g.presidente]) byPresidente[g.presidente] = [];
      byPresidente[g.presidente].push(g);
    }
    const presidenti = Object.keys(byPresidente).sort();
    res.render("fanta/giocatori", { giocatori, byPresidente, presidenti, currentUser: req.user, error: null });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.render("fanta/giocatori", { giocatori: [], byPresidente: {}, presidenti: [], currentUser: req.user, error: err.message });
  }
}

async function showListaGiocatori(req, res) {
  try {
    const dataFiltro = req.query.dataQuotazione || null;

    const giocatori = await prisma.giocatore.findMany({
      orderBy: [{ ruolo: "asc" }, { nome: "asc" }],
      include: { contratti: { select: { id: true } } },
    });

    // Date distinte disponibili nella tabella quotazioni
    const rawDates = await prisma.$queryRaw`
      SELECT DISTINCT DATE("createdAt") AS data
      FROM quotazioni
      ORDER BY data DESC
    `;
    const dateDisponibili = rawDates.map(r => {
      const d = r.data;
      if (d instanceof Date) return d.toISOString().split("T")[0];
      return String(r.data).split("T")[0];
    });

    // Se è selezionata una data specifica, carica i valori storici di quel giorno
    let valoriStorici = null;
    if (dataFiltro) {
      const qstorico = await prisma.$queryRaw`
        SELECT DISTINCT ON ("giocatoreId") "giocatoreId", valore
        FROM quotazioni
        WHERE DATE("createdAt") = ${dataFiltro}::date
        ORDER BY "giocatoreId", "createdAt" DESC
      `;
      valoriStorici = {};
      qstorico.forEach(q => {
        valoriStorici[q.giocatoreId] = q.valore !== null ? Number(q.valore) : null;
      });
    }

    const ruoliEstesi = [...new Set(giocatori.map(g => g.ruoloEsteso).filter(Boolean))].sort();

    // Usa solo le squadre attive dai parametri (Serie A configurate)
    const activeTeamNames = await parametriService.getSerieATeamNames();
    let squadre;
    if (activeTeamNames) {
      const activeSet = new Set(activeTeamNames.map(n => n.toLowerCase()));
      squadre = [...new Set(giocatori.map(g => g.squadra).filter(s => s && activeSet.has(s.toLowerCase())))].sort();
    } else {
      squadre = [...new Set(giocatori.map(g => g.squadra).filter(Boolean))].sort();
    }

    res.render("fanta/lista-giocatori", {
      giocatori, ruoliEstesi, squadre,
      currentUser: req.user,
      gSaved:   req.query.gSaved === "1",
      gDeleted: req.query.gDeleted === "1",
      gError:   req.query.gError || null,
      error: null,
      dateDisponibili,
      dataFiltro,
      valoriStorici,
    });
  } catch (err) {
    console.error("DB error:", err.message);
    res.render("fanta/lista-giocatori", {
      giocatori: [], ruoliEstesi: [], squadre: [],
      currentUser: req.user,
      gSaved: false, gDeleted: false, gError: null,
      error: err.message,
      dateDisponibili: [], dataFiltro: null, valoriStorici: null,
    });
  }
}

// ── Movimenti helpers ────────────────────────────────────────────────────────

function _mvDelta(obj) {
  if (!obj || obj.prima == null || obj.dopo == null) return 0;
  return Math.round((Number(obj.dopo) - Number(obj.prima)) * 100) / 100;
}
function _mvDelta2(a, b) {
  if (a == null || b == null) return 0;
  return Math.round((Number(b) - Number(a)) * 100) / 100;
}
function _mvExtractDeltas(det, src) {
  if (src === "premi") {
    return {
      crediti:    _mvDelta2(det.prima && det.prima.crediti, det.dopo && det.dopo.crediti),
      stipendi:   0,
      valoreRosa: 0,
    };
  }
  if (src === "rinnovo") {
    const oldStip = det.pre  && det.pre.importoOperazione  != null ? Number(det.pre.importoOperazione)  : 0;
    const newStip = det.post && det.post.importoOperazione != null ? Number(det.post.importoOperazione) : 0;
    return {
      crediti:    0,
      stipendi:   Math.round((newStip - oldStip) * 100) / 100,
      valoreRosa: 0,
    };
  }
  if (det.movimento) {
    const m = det.movimento;
    return {
      crediti:    _mvDelta(m.crediti),
      stipendi:   _mvDelta(m.stipendi),
      valoreRosa: 0,
    };
  }
  if (det.operazione === "aggiustamento_crediti") {
    return {
      crediti:    _mvDelta2(det.prima && det.prima.crediti, det.dopo && det.dopo.crediti),
      stipendi:   0,
      valoreRosa: 0,
    };
  }
  if (det.tipo === "fine-stagione-svincolo") {
    return {
      crediti:    _mvDelta2(det.pre && det.pre.crediti,    det.post && det.post.crediti),
      stipendi:   _mvDelta2(det.pre && det.pre.stipendi,   det.post && det.post.stipendi),
      valoreRosa: _mvDelta2(det.pre && det.pre.valoreRose, det.post && det.post.valoreRose),
    };
  }
  // generic prima/dopo
  if (det.prima && det.dopo) {
    return {
      crediti:    _mvDelta2(det.prima.crediti, det.dopo.crediti),
      stipendi:   _mvDelta2(det.prima.stipendi, det.dopo.stipendi),
      valoreRosa: _mvDelta2(det.prima.valoreRose, det.dopo.valoreRose),
    };
  }
  return { crediti: 0, stipendi: 0, valoreRosa: 0 };
}
function _mvTipoOp(det, src) {
  if (src === "premi")                              return "PREMIO";
  if (src === "rinnovo")                            return "RINNOVO";
  if (det.movimento && det.movimento.ruolo === "acquirente") return "ACQUISTO";
  if (det.movimento && det.movimento.ruolo === "venditore")  return "VENDITA";
  if (det.operazione === "aggiustamento_crediti")   return "AGGIUSTAMENTO";
  if (det.tipo === "fine-stagione-svincolo")        return "SVINCOLO";
  return "ALTRO";
}
function _mvDescrizione(det, contratto, src) {
  if (src === "premi") {
    const pos  = det.posizione  || "?";
    const pct  = det.percentuale || "";
    const prem = det.premio      != null ? Number(det.premio).toFixed(2) + " M" : "";
    return `Premio classifica – pos. ${pos}${pct ? " (" + pct + ")" : ""}${prem ? " → +" + prem : ""}`;
  }
  if (det.movimento) {
    const nome = contratto && contratto.giocatore ? contratto.giocatore.nome : (det.contrattoId ? `#${det.contrattoId}` : "?");
    const ruolo = contratto && contratto.giocatore ? contratto.giocatore.ruolo : "";
    const nomeStr = ruolo ? `[${ruolo}] ${nome}` : nome;
    if (det.movimento.ruolo === "acquirente") {
      const prov = det.movimento.provenienza || null;
      return `Acquisto: ${nomeStr}${prov ? " da " + prov : ""}`;
    }
    return `Vendita P2P: ${nomeStr}`;
  }
  if (det.operazione === "aggiustamento_crediti") {
    const imp = det.importo != null ? (Number(det.importo) > 0 ? "+" : "") + Number(det.importo).toFixed(2) + " M" : "";
    return `Aggiustamento crediti${imp ? " " + imp : ""}${det.motivo ? " – " + det.motivo : ""}`;
  }
  if (det.tipo === "fine-stagione-svincolo") {
    const gn = det.giocatoreNome || "?";
    const mot = det.motivo === "rinnovo-bocciato" ? "bocciato" : "scaduto";
    const qt  = det.quotazioneAccredito != null ? " +Q" + Number(det.quotazioneAccredito).toFixed(2) : "";
    return `Svincolo (${mot}): ${gn}${qt}`;
  }
  if (det.tipo === "fine-stagione-rinnovo") {
    const g = contratto && contratto.giocatore;
    const nome = g ? `[${g.ruolo}] ${g.nome}` : (det.post && det.post.giocatoreId ? `#${det.post.giocatoreId}` : "?");
    const oldStip = det.pre  && det.pre.importoOperazione  != null ? Number(det.pre.importoOperazione).toFixed(2)  : "?";
    const newStip = det.post && det.post.importoOperazione != null ? Number(det.post.importoOperazione).toFixed(2) : "?";
    const durata  = det.post && det.post.durataContratto ? det.post.durataContratto + "a" : "";
    return `Rinnovo: ${nome} \u2013 stip. ${oldStip} \u2192 ${newStip} M${durata ? " (" + durata + ")" : ""}`;
  }
  return det.tipo || det.operazione || "Movimento";
}

// ── GET /fanta/movimenti ────────────────────────────────────────────────────
// Estratto conto progressivo del presidente: ogni riga mostra delta e saldo
// running calcolato in ordine ASC createdAt, id. Visualizzato in DESC.
// Nessun filtro per stagione: i movimenti sono continui e globali.
async function showMovimenti(req, res) {
  const params = await parametriService.getAll();
  const budgetIniziale = parseFloat(params.budget_iniziale || "100");

  const team = await prisma.fantaTeam.findFirst({ where: { userId: req.user.id } });
  if (!team) {
    return res.render("fanta/movimenti", {
      currentUser: req.user, team: null,
      righe: [], saldoIniziale: budgetIniziale, saldoAttuale: null, params,
    });
  }

  // Tutti i record SF del team — cerca per fantaTeamId OPPURE per nomePresidente
  // (fallback necessario quando fantaTeamId non è stato ancora associato al record SF).
  const nickname = req.user.nickname || req.user.email.split("@")[0];
  const tuttiSf = await prisma.situazioneFinanziaria.findMany({
    where: {
      OR: [
        { fantaTeamId: team.id },
        { nomePresidente: { equals: nickname, mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  // Deduplica per id (OR potrebbe matchare la stessa riga su entrambi i criteri)
  const sfById = new Map(tuttiSf.map((s) => [s.id, s]));
  const sfIds = [...sfById.keys()];

  if (sfIds.length === 0) {
    return res.render("fanta/movimenti", {
      currentUser: req.user, team,
      righe: [], saldoIniziale: budgetIniziale, saldoAttuale: null, params,
    });
  }

  // ── 1. Log diretti sulle SF (P2P, aggiustamenti, svincoli)
  const logsSf = await prisma.log.findMany({
    where: { entita: "situazione_finanziaria", entitaId: { in: sfIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // ── 2. Premi erogati: log con movimenti[].sfId in sfIds
  const logsPremiRaw = await prisma.log.findMany({
    where: { entita: "premi_erogati" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const logsPremi = [];
  const sfIdSet = new Set(sfIds);
  for (const l of logsPremiRaw) {
    let det = {};
    try { det = JSON.parse(l.dettaglio || "{}"); } catch { continue; }
    if (!Array.isArray(det.movimenti)) continue;
    const mv = det.movimenti.find((m) => sfIdSet.has(m.sfId));
    if (!mv) continue;
    logsPremi.push({ _raw: l, _mv: mv });
  }

  // ── 3. Rinnovi: log CREATE su contratti del team con tipo "fine-stagione-rinnovo"
  const teamContrattiIds = await prisma.contratto.findMany({
    where: { fantaTeamId: team.id },
    select: { id: true },
  });
  const logsRinnoviRaw = teamContrattiIds.length
    ? await prisma.log.findMany({
        where: { entita: "contratto", azione: "CREATE", entitaId: { in: teamContrattiIds.map((c) => c.id) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const logsRinnovi = [];
  for (const l of logsRinnoviRaw) {
    let det = {};
    try { det = JSON.parse(l.dettaglio || "{}"); } catch { continue; }
    if (det.tipo !== "fine-stagione-rinnovo") continue;
    logsRinnovi.push({ _raw: l, _det: det });
  }

  // ── 4. Unisci e ordina ASC (createdAt ASC, id ASC — determinismo assoluto)
  const allEntries = [
    ...logsSf.map((l)  => ({ id: l.id, createdAt: l.createdAt, rollbacked: l.rollbacked, _src: "sf",     _log: l,        _det: null })),
    ...logsPremi.map((x) => ({ id: x._raw.id, createdAt: x._raw.createdAt, rollbacked: x._raw.rollbacked, _src: "premi",  _log: x._raw,   _det: x._mv })),
    ...logsRinnovi.map((x) => ({ id: x._raw.id, createdAt: x._raw.createdAt, rollbacked: x._raw.rollbacked, _src: "rinnovo", _log: x._raw, _det: x._det })),
  ].sort((a, b) => {
    const dt = new Date(a.createdAt) - new Date(b.createdAt);
    if (dt !== 0) return dt;
    return a.id - b.id;
  });

  // ── 5. Batch-fetch contratti per arricchire le descrizioni (SF + rinnovi)
  const contrattoIds = [];
  for (const e of allEntries) {
    if (e._src === "sf") {
      let det = {};
      try { det = JSON.parse(e._log.dettaglio || "{}"); } catch { continue; }
      if (det.contrattoId) contrattoIds.push(det.contrattoId);
    } else if (e._src === "rinnovo") {
      if (e._det && e._det.post && e._det.post.id) contrattoIds.push(e._det.post.id);
    }
  }
  const contrattiBatch = contrattoIds.length
    ? await prisma.contratto.findMany({
        where: { id: { in: [...new Set(contrattoIds)] } },
        include: { giocatore: { select: { nome: true, ruolo: true } } },
      })
    : [];
  const contrattoMap = new Map(contrattiBatch.map((c) => [c.id, c]));

  // ── 5. Calcolo running total (ASC → progressivo corretto)
  let runCrediti    = budgetIniziale;
  let runStipendi   = 0;
  let runValoreRosa = 0;

  const righe = allEntries.map((entry) => {
    let det = {};
    if (entry._src === "sf") {
      try { det = JSON.parse(entry._log.dettaglio || "{}"); } catch {}
    } else {
      det = entry._det;
    }

    const deltas    = _mvExtractDeltas(det, entry._src);
    // Per rinnovi il contratto si trova tramite det.post.id, non det.contrattoId
    const contrattoLookupId = entry._src === "rinnovo"
      ? (det.post && det.post.id)
      : det.contrattoId;
    const contratto = contrattoLookupId ? contrattoMap.get(contrattoLookupId) : null;

    runCrediti    = Math.round((runCrediti    + deltas.crediti)    * 100) / 100;
    runStipendi   = Math.round((runStipendi   + deltas.stipendi)   * 100) / 100;
    runValoreRosa = Math.round((runValoreRosa + deltas.valoreRosa) * 100) / 100;

    return {
      logId:          entry.id,
      createdAt:      entry.createdAt,
      tipoOp:         _mvTipoOp(det, entry._src),
      descrizione:    _mvDescrizione(det, contratto, entry._src),
      deltaCrediti:   deltas.crediti,
      deltaStipendi:  deltas.stipendi,
      deltaValoreRosa: deltas.valoreRosa,
      saldoCrediti:   runCrediti,
      saldoStipendi:  runStipendi,
      saldoValoreRosa: runValoreRosa,
      rollbacked:     entry.rollbacked || false,
    };
  });

  // Saldo attuale = ultima riga del running total (oppure budgetIniziale se nessun movimento)
  const saldoAttuale = righe.length > 0 ? {
    crediti:    righe[righe.length - 1].saldoCrediti,
    stipendi:   righe[righe.length - 1].saldoStipendi,
    valoreRosa: righe[righe.length - 1].saldoValoreRosa,
  } : null;

  // ── 6. Inverti per visualizzazione DESC (più recente in cima)
  righe.reverse();

  // ── 7. Paginazione (20 righe per pagina)
  const PAGE_SIZE = 20;
  const totalRighe = righe.length;
  const totalPages = Math.max(1, Math.ceil(totalRighe / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, parseInt(req.query.page) || 1));
  const righePaginate = righe.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  res.render("fanta/movimenti", {
    currentUser: req.user,
    team,
    righe: righePaginate,
    totalRighe,
    page,
    totalPages,
    saldoIniziale: budgetIniziale,
    saldoAttuale,
    params,
  });
}

// ── GET /fanta/rinnovi/check ────────────────────────────────────────────────
// Riepilogo dei rinnovi/svincoli di fine stagione per il team del presidente loggato.
async function showRinnoviCheck(req, res) {
  const params = await parametriService.getAll();
  const team = await prisma.fantaTeam.findFirst({ where: { userId: req.user.id } });

  if (!team) {
    return res.render("fanta/rinnovi-check", {
      currentUser: req.user, team: null,
      rinnovi: [], svincoliBocciati: [], svincoliNaturali: [], confermati: [],
      batchDate: null, totaleStipendi: 0, params,
    });
  }

  // Tutti i contratti del team (validi e non)
  const allContracts = await prisma.contratto.findMany({
    where: { fantaTeamId: team.id },
    include: { giocatore: { select: { id: true, nome: true, ruolo: true, squadra: true } } },
  });
  const allIds = allContracts.map((c) => c.id);
  const contractMap = {};
  for (const c of allContracts) contractMap[c.id] = c;

  // Log fine-stagione su tutti i contratti del team
  const logs = allIds.length
    ? await prisma.log.findMany({
        where: { entita: "contratto", entitaId: { in: allIds } },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const rinnoviMap   = {}; // nuovoContrattoId → info
  const svincoliMap  = {}; // oldContrattoId → info

  for (const l of logs) {
    let det = {};
    try { det = JSON.parse(l.dettaglio || "{}"); } catch { /* ignore */ }

    if (l.azione === "CREATE" && det.tipo === "fine-stagione-rinnovo") {
      rinnoviMap[l.entitaId] = {
        preId:          det.pre  && det.pre.id,
        preStipendio:   det.pre  && det.pre.importoOperazione,
        preDurata:      det.pre  && det.pre.durataContratto,
        quotazione:     det.quotazione,
        nuovoStipendio: det.post && det.post.importoOperazione,
        nuovaDurata:    det.post && det.post.durataContratto,
        nuovaDataFine:  det.post && det.post.dataFine,
        createdAt:      l.createdAt,
      };
    }

    if (l.azione === "UPDATE" && det.tipo === "fine-stagione-svincolo") {
      svincoliMap[l.entitaId] = {
        motivo:    det.motivo,
        stipendio: det.pre && (det.pre.importoOperazione !== undefined ? det.pre.importoOperazione : null),
        createdAt: l.createdAt,
      };
    }
  }

  const RUOLO_ORD = { P: 0, D: 1, C: 2, A: 3 };

  // Rinnovi
  const rinnovi = Object.entries(rinnoviMap).map(([nuovoId, info]) => {
    const c = contractMap[parseInt(nuovoId, 10)];
    return {
      giocatore:      c && c.giocatore,
      preStipendio:   info.preStipendio,
      preDurata:      info.preDurata,
      quotazione:     info.quotazione,
      nuovoContrattoId: parseInt(nuovoId, 10),
      nuovoStipendio: info.nuovoStipendio !== undefined ? info.nuovoStipendio
                        : (c && c.importoOperazione ? Number(c.importoOperazione) : null),
      nuovaDurata:    info.nuovaDurata !== undefined ? info.nuovaDurata : (c && c.durataContratto),
      nuovaDataFine:  info.nuovaDataFine || (c && c.dataFine),
    };
  }).sort((a, b) => (RUOLO_ORD[a.giocatore && a.giocatore.ruolo] ?? 4) - (RUOLO_ORD[b.giocatore && b.giocatore.ruolo] ?? 4));

  // Svincoli
  const svincoliBocciati = [];
  const svincoliNaturali = [];
  for (const [oldId, info] of Object.entries(svincoliMap)) {
    const c = contractMap[parseInt(oldId, 10)];
    const item = {
      giocatore:   c && c.giocatore,
      contrattoId: parseInt(oldId, 10),
      tipo:        c && c.tipo,
      stipendio:   info.stipendio !== null ? info.stipendio
                     : (c && c.importoOperazione ? Number(c.importoOperazione) : null),
    };
    if (info.motivo === "rinnovo-bocciato") svincoliBocciati.push(item);
    else                                     svincoliNaturali.push(item);
  }
  const svSort = (a, b) => (RUOLO_ORD[a.giocatore && a.giocatore.ruolo] ?? 4) - (RUOLO_ORD[b.giocatore && b.giocatore.ruolo] ?? 4);
  svincoliBocciati.sort(svSort);
  svincoliNaturali.sort(svSort);

  // Confermati: contratti validi non generati da rinnovo di questa stagione
  const rinnoviNewIds = new Set(Object.keys(rinnoviMap).map(Number));
  const confermati = allContracts
    .filter((c) => c.valido && !rinnoviNewIds.has(c.id))
    .sort((a, b) => {
      const ro = (RUOLO_ORD[a.giocatore && a.giocatore.ruolo] ?? 4) - (RUOLO_ORD[b.giocatore && b.giocatore.ruolo] ?? 4);
      return ro !== 0 ? ro : Number(b.importoOperazione || 0) - Number(a.importoOperazione || 0);
    });

  // Data del batch più recente
  const batchDates = [...Object.values(rinnoviMap), ...Object.values(svincoliMap)]
    .map((x) => x.createdAt).filter(Boolean).sort((a, b) => new Date(b) - new Date(a));
  const batchDate = batchDates[0]
    ? new Date(batchDates[0]).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  // Totale stipendi rosa attuale
  const validContracts = allContracts.filter((c) => c.valido);
  const totaleStipendi = validContracts.reduce((sum, c) => sum + (c.importoOperazione ? Number(c.importoOperazione) : 0), 0);

  res.render("fanta/rinnovi-check", {
    currentUser: req.user,
    team, rinnovi, svincoliBocciati, svincoliNaturali, confermati,
    batchDate, totaleStipendi: Math.round(totaleStipendi * 100) / 100, params,
  });
}

module.exports = { showClassifica, showRiepilogo, showPresidente, showFinanze, showDiario, showLog, showGiocatori, showListaGiocatori, showRose, showRosaDettaglio, showRegolamento, showDashboard, showRinnoviCheck, showMovimenti };

// ── GET /fanta/rose ───────────────────────────────────────────────────────────
async function showRose(req, res) {
  try {
    const params = await parametriService.getAll();
    const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
    const now = new Date();
    const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
    const stagione = `${annoInizio}-${annoInizio + 1}`;

    // Tutti i team con contratti validi e rosa assignments (solo utenti attivi)
    const teams = await prisma.fantaTeam.findMany({
      where: { OR: [{ userId: null }, { user: { isActive: true } }] },
      orderBy: { nome: "asc" },
      include: {
        user: { select: { nickname: true, email: true } },
        contratti: {
          where: { valido: true },
          include: { giocatore: true },
        },
        rosaGiocatori: {
          select: { giocatoreId: true, categoria: true },
        },
      },
    });

    const ruoloOrdine = { P: 0, D: 1, C: 2, A: 3 };

    const roseData = teams.map((team) => {
      const rosaMap = {};
      team.rosaGiocatori.forEach((r) => { rosaMap[r.giocatoreId] = r.categoria; });

      const giocatori = team.contratti.map((c) => ({
        id: c.giocatore.id,
        nome: c.giocatore.nome,
        ruolo: c.giocatore.ruolo,
        squadra: c.giocatore.squadra,
        eta: c.giocatore.eta,
        valore: c.giocatore.valore ? +c.giocatore.valore : null,
        categoria: rosaMap[c.giocatore.id] || "InRosa",
      }));

      const inRosa = giocatori
        .filter((g) => g.categoria === "InRosa")
        .sort((a, b) => (ruoloOrdine[a.ruolo] ?? 9) - (ruoloOrdine[b.ruolo] ?? 9) || a.nome.localeCompare(b.nome));
      const fuoriRosa = giocatori
        .filter((g) => g.categoria === "FuoriRosa")
        .sort((a, b) => (ruoloOrdine[a.ruolo] ?? 9) - (ruoloOrdine[b.ruolo] ?? 9) || a.nome.localeCompare(b.nome));
      const u21 = giocatori
        .filter((g) => g.categoria === "U21")
        .sort((a, b) => (ruoloOrdine[a.ruolo] ?? 9) - (ruoloOrdine[b.ruolo] ?? 9) || a.nome.localeCompare(b.nome));

      return {
        id: team.id,
        nome: team.nome,
        presidente: team.user?.nickname || team.user?.email || "—",
        inRosa,
        fuoriRosa,
        u21,
        totale: giocatori.length,
      };
    });

    res.render("fanta/rose", {
      roseData,
      stagione,
      currentUser: req.user,
      error: null,
    });
  } catch (err) {
    console.error("showRose error:", err.message);
    res.render("fanta/rose", {
      roseData: [],
      stagione: "",
      currentUser: req.user,
      error: "Errore nel caricamento: " + err.message,
    });
  }
}

// ── GET /fanta/rose/:fantaTeamId ──────────────────────────────────────────────
async function showRosaDettaglio(req, res) {
  try {
    const fantaTeamId = parseInt(req.params.fantaTeamId, 10);
    if (isNaN(fantaTeamId)) return res.redirect("/fanta/rose");

    const params = await parametriService.getAll();
    const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
    const now = new Date();
    const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
    const stagione = `${annoInizio}-${annoInizio + 1}`;

    const fantaTeam = await prisma.fantaTeam.findUnique({
      where: { id: fantaTeamId },
      include: {
        user: { select: { nickname: true, email: true } },
        contratti: {
          where: { valido: true },
          include: { giocatore: true },
        },
        rosaGiocatori: {
          select: { giocatoreId: true, categoria: true },
        },
      },
    });

    if (!fantaTeam) return res.redirect("/fanta/rose");

    const rosaMap = {};
    fantaTeam.rosaGiocatori.forEach((r) => { rosaMap[r.giocatoreId] = r.categoria; });

    const ruoloOrdine = { P: 0, D: 1, C: 2, A: 3 };

    const giocatori = fantaTeam.contratti.map((c) => {
      const anni = getRemainingContractYears(c.dataFine);
      return {
        id: c.giocatore.id,
        nome: c.giocatore.nome,
        ruolo: c.giocatore.ruolo,
        squadra: c.giocatore.squadra,
        eta: c.giocatore.eta,
        valore: c.giocatore.valore ? +c.giocatore.valore : null,
        anniContratto: anni != null ? anni : c.durataContratto,
        tipo: c.tipo,
        dataFine: c.dataFine || null,
        categoria: rosaMap[c.giocatore.id] || "InRosa",
      };
    }).sort((a, b) => (ruoloOrdine[a.ruolo] ?? 9) - (ruoloOrdine[b.ruolo] ?? 9) || a.nome.localeCompare(b.nome));

    res.render("fanta/rosa-dettaglio", {
      fantaTeam,
      presidente: fantaTeam.user?.nickname || fantaTeam.user?.email || "—",
      giocatori,
      stagione,
      currentUser: req.user,
      error: null,
    });
  } catch (err) {
    console.error("showRosaDettaglio error:", err.message);
    res.redirect("/fanta/rose");
  }
}

// ── GET /fanta/regolamento ────────────────────────────────────────────────────
function showRegolamento(req, res) {
  res.render("fanta/regolamento", { currentUser: req.user });
}

// ── GET / (Dashboard del fantapresidente loggato) ─────────────────────────────
async function showDashboard(req, res) {
  const user = req.user;
  try {
    if (!user.fantaTeam) {
      return res.render("dashboard", {
        currentUser: user, fantaTeam: null, stagione: null, stats: null,
      });
    }

    const params = await parametriService.getAll();
    const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
    const now = new Date();
    const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
    const stagione = `${annoInizio}-${annoInizio + 1}`;

    const [contratti, sf, rosaAssegnazioni] = await Promise.all([
      prisma.contratto.findMany({
        where:   { fantaTeamId: user.fantaTeam.id, valido: true },
        include: {
          giocatore: {
            select: {
              id: true, nome: true, ruolo: true, ruoloEsteso: true,
              valore: true, eta: true, squadra: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.situazioneFinanziaria.findFirst({
        where:  { fantaTeamId: user.fantaTeam.id, stagione },
        select: { crediti: true },
      }),
      prisma.rosaGiocatore.findMany({
        where:  { fantaTeamId: user.fantaTeam.id, stagione },
        select: { giocatoreId: true, categoria: true },
      }),
    ]);

    // mappa giocatoreId → categoria (default InRosa)
    const categoriaMap = {};
    for (const r of rosaAssegnazioni) categoriaMap[r.giocatoreId] = r.categoria;

    // anni rimanenti via helper centralizzato (Regola di Giugno applicata)
    const anniRimanenti = (dataFine) => getRemainingContractYears(dataFine);

    // Aggreghiamo solo i contratti Acquisto, evitando duplicati per giocatore
    const ruoloOrdine = { P: 0, D: 1, C: 2, A: 3 };
    let totaleStipendi = 0;
    const acquistiVisti = new Set();
    const gruppi = { InRosa: [], FuoriRosa: [], U21: [] };
    let inScadenzaCount = 0;
    for (const c of contratti) {
      if (c.tipo !== "Acquisto") continue;
      if (acquistiVisti.has(c.giocatoreId)) continue;
      acquistiVisti.add(c.giocatoreId);
      totaleStipendi += c.importoOperazione ? +c.importoOperazione : 0;
      const anni = anniRimanenti(c.dataFine);
      if (anni !== null && anni <= 1) inScadenzaCount++;
      const categoria = categoriaMap[c.giocatoreId] || "InRosa";
      (gruppi[categoria] || gruppi.InRosa).push({
        nome:        c.giocatore.nome,
        ruolo:       c.giocatore.ruolo,
        ruoloEsteso: c.giocatore.ruoloEsteso || "",
        valore:      c.giocatore.valore !== null ? +c.giocatore.valore : null,
        eta:         c.giocatore.eta,
        squadra:     c.giocatore.squadra || "",
        anni,
        dataFine:    c.dataFine,
      });
    }
    const sortByRuolo = (a, b) =>
      (ruoloOrdine[a.ruolo] ?? 9) - (ruoloOrdine[b.ruolo] ?? 9) ||
      a.nome.localeCompare(b.nome);
    gruppi.InRosa.sort(sortByRuolo);
    gruppi.FuoriRosa.sort(sortByRuolo);
    gruppi.U21.sort(sortByRuolo);

    res.render("dashboard", {
      currentUser: user,
      fantaTeam:   user.fantaTeam,
      stagione,
      stats: {
        totaleGiocatori: acquistiVisti.size,
        inScadenzaCount,
        gruppi,
        countInRosa:    gruppi.InRosa.length,
        countFuoriRosa: gruppi.FuoriRosa.length,
        countU21:       gruppi.U21.length,
        totaleStipendi:  Math.round(totaleStipendi * 100) / 100,
        crediti:         sf ? +sf.crediti : null,
      },
    });
  } catch (err) {
    console.error("showDashboard error:", err.message);
    res.render("dashboard", {
      currentUser: user, fantaTeam: user.fantaTeam || null, stagione: null, stats: null,
    });
  }
}
