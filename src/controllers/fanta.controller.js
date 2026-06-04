// src/controllers/fanta.controller.js
const sheets = require("../services/sheets.service");
const prisma  = require("../lib/prisma");
const parametriService = require("../services/parametri.service");

async function showClassifica(req, res) {
  try {
    const stagioni = await prisma.situazioneFinanziaria.findMany({
      distinct: ["stagione"],
      orderBy: { stagione: "desc" },
      select: { stagione: true },
    });

    // Default = stagione corrente derivata da oggi + parametro stagione_inizio (GG-MM).
    // Se la stagione corrente non ha record SF, fallback alla più recente in tabella.
    const params = await parametriService.getAll();
    const stagioneInizio = params.stagione_inizio || "01-07";
    const meseInizio = parseInt(stagioneInizio.split("-")[1], 10) || 7;
    const oggi = new Date();
    const meseOggi = oggi.getMonth() + 1;
    const annoStagione = meseOggi >= meseInizio ? oggi.getFullYear() : oggi.getFullYear() - 1;
    const stagioneCorrente = `${annoStagione}-${annoStagione + 1}`;
    const stagioneEsiste = stagioni.some((s) => s.stagione === stagioneCorrente);
    const defaultStagione = stagioneEsiste ? stagioneCorrente : stagioni[0]?.stagione || null;

    const stagioneFiltro = req.query.stagione || defaultStagione;

    const rawRecords = stagioneFiltro
      ? await prisma.situazioneFinanziaria.findMany({
          where: { stagione: stagioneFiltro },
          orderBy: { patrimonio: "desc" },
          include: { fantaTeam: true },
        })
      : [];

    // Fallback: alcune righe SF non hanno fantaTeamId valorizzato (assegnazione admin manuale).
    // Risolviamo via nomePresidente con cascading: nickname esatto → email prefix esatto → substring nell'email.
    const usersWithTeam = await prisma.user.findMany({
      where: { fantaTeam: { isNot: null } },
      select: { nickname: true, email: true, fantaTeam: { select: { id: true, nome: true } } },
    });
    const norm = (s) => (s || "").trim().toLowerCase();
    // I nickname letterali "null" sono un bug a monte: filtriamoli.
    const isValidNick = (n) => n && norm(n) !== "null" && norm(n) !== "";

    function resolveTeam(nomePresidente) {
      const nN = norm(nomePresidente);
      if (!nN) return null;
      // 1. Nickname esatto
      for (const u of usersWithTeam) {
        if (isValidNick(u.nickname) && norm(u.nickname) === nN) return u.fantaTeam;
      }
      // 2. Email prefix esatto
      for (const u of usersWithTeam) {
        if (u.email && norm(u.email.split("@")[0]) === nN) return u.fantaTeam;
      }
      // 3. nomePresidente come substring dell'email (es. "Giulio" in "giuliosergente@…")
      for (const u of usersWithTeam) {
        if (u.email && norm(u.email).includes(nN)) return u.fantaTeam;
      }
      return null;
    }

    // Risolvi fantaTeamId effettivo per ciascun record SF: usa quello esplicito
    // se presente, altrimenti tenta resolveTeam(nomePresidente). Indispensabile
    // perché molti record SF storici hanno fantaTeamId=null e senza questo
    // mapping il fallback usa il valoreRose STORATO (stale, pre-scraping).
    const effectiveTeamIdByRow = rawRecords.map((r) => r.fantaTeamId || resolveTeam(r.nomePresidente)?.id || null);

    // Calcola valori dinamicamente dai contratti validi e giocatori attivi
    const teamIds = effectiveTeamIdByRow.filter((id) => id != null);
    const contrattiValidi = teamIds.length > 0
      ? await prisma.contratto.findMany({
          where: {
            fantaTeamId: { in: teamIds },
            valido: true,
          },
          include: { giocatore: { select: { id: true, valore: true, eta: true, active: true } } },
        })
      : [];

    // Mappa fantaTeamId → statistiche calcolate
    const statsMap = {};
    for (const c of contrattiValidi) {
      // NON filtrare per giocatore.active: finché esiste un contratto valido,
      // il giocatore concorre alla rosa del team. Lo svincolo definitivo
      // (active=false E rimborso crediti) si applica solo via
      // /admin/svincoli-inattivi, che setta contratto.valido=false.
      if (!statsMap[c.fantaTeamId]) {
        statsMap[c.fantaTeamId] = {
          valoreRose: 0, giocatoriIds: new Set(), etaSomma: 0, etaCount: 0,
          stipendi: 0, montePrestiti: 0,
        };
      }
      const s = statsMap[c.fantaTeamId];

      // Evita duplicati per giocatore (prende solo il primo contratto valido trovato)
      if (s.giocatoriIds.has(c.giocatore.id)) continue;
      s.giocatoriIds.add(c.giocatore.id);

      if (c.tipo === "Acquisto") {
        s.valoreRose += c.giocatore.valore ? +c.giocatore.valore : 0;
        s.stipendi += c.importoOperazione ? +c.importoOperazione : 0;
      } else if (c.tipo === "Prestito") {
        s.montePrestiti += c.importoOperazione ? +c.importoOperazione : 0;
      }

      if (c.giocatore.eta != null) {
        s.etaSomma += c.giocatore.eta;
        s.etaCount++;
      }
    }

    // Converte Decimal → Number e sovrascrive con valori calcolati
    const classifica = rawRecords.map((p, idx) => {
      const effId = effectiveTeamIdByRow[idx];
      const s = effId && statsMap[effId] ? statsMap[effId] : null;
      const valoreRoseCalcolato = s ? Math.round(s.valoreRose * 100) / 100 : +p.valoreRose;
      const crediti = +p.crediti;
      const giocatoriTesserati = s ? s.giocatoriIds.size : p.giocatoriTesserati;
      const etaMedia = s && s.etaCount > 0 ? Math.round((s.etaSomma / s.etaCount) * 100) / 100 : +p.etaMedia;
      const stipendi = s ? Math.round(s.stipendi * 100) / 100 : +p.stipendi;
      const montePrestiti = s ? Math.round(s.montePrestiti * 100) / 100 : +p.montePrestiti;

      return {
        ...p,
        fantaTeam:       p.fantaTeam || resolveTeam(p.nomePresidente),
        valoreRose:      valoreRoseCalcolato,
        crediti,
        patrimonio:      Math.round((valoreRoseCalcolato + crediti) * 100) / 100,
        giocatoriTesserati,
        etaMedia,
        stipendi,
        montePrestiti,
        ultimoPlusMinus: +p.ultimoPlusMinus,
      };
    });

    // Riordina per patrimonio (ora ricalcolato)
    classifica.sort((a, b) => b.patrimonio - a.patrimonio);

    // ── Dettaglio rosa admin-only ──────────────────────────────────────────
    // Se ?teamDetail=<fantaTeamId> e utente ADMIN: carica i giocatori che
    // compongono il valoreRose della classifica per quel team (Acquisto
    // valido + active). Lista usata per popolare combobox = teams in classifica.
    // NB: usa p.fantaTeam direttamente (già risolto via resolveTeam) per
    // evitare disallineamenti di indici dopo classifica.sort().
    const teamsPerCombobox = classifica
      .map((p) => ({
        id: p.fantaTeam && p.fantaTeam.id ? p.fantaTeam.id : null,
        nome: p.fantaTeam ? p.fantaTeam.nome : p.nomePresidente,
        nomePresidente: p.nomePresidente,
      }))
      .filter((t) => t.id != null)
      .sort((a, b) => a.nome.localeCompare(b.nome));

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
          // Include anche giocatori active=false con contratto valido (svincolo
          // non ancora applicato → giocatore conta ancora come sotto contratto).
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
        // Ordina alfabeticamente per nome giocatore crescente
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
      stagioneFiltro,
      stagioni: stagioni.map((s) => s.stagione),
      currentUser: req.user,
      teamsPerCombobox,
      teamDetail,
      error: null,
    });
  } catch (err) {
    console.error("showClassifica error:", err.message);
    res.render("fanta/classifica", {
      classifica: [],
      stagioneFiltro: null,
      stagioni: [],
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
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const oggi = new Date();
  const meseOggi = oggi.getMonth() + 1;
  const anno = meseOggi >= meseInizio ? oggi.getFullYear() : oggi.getFullYear() - 1;
  const stagione = `${anno}-${anno + 1}`;

  const sfs = await prisma.situazioneFinanziaria.findMany({ where: { stagione } });
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
  return Math.round(((max + min) / 2) * 0.25 * 100) / 100;
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

module.exports = { showClassifica, showRiepilogo, showPresidente, showFinanze, showDiario, showLog, showGiocatori, showListaGiocatori, showRose, showRosaDettaglio, showRegolamento, showDashboard };

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
          where: { stagione },
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
          where: { stagione },
          select: { giocatoreId: true, categoria: true },
        },
      },
    });

    if (!fantaTeam) return res.redirect("/fanta/rose");

    const rosaMap = {};
    fantaTeam.rosaGiocatori.forEach((r) => { rosaMap[r.giocatoreId] = r.categoria; });

    const ruoloOrdine = { P: 0, D: 1, C: 2, A: 3 };

    // Calcola anni rimanenti dalla dataFine del contratto
    const meseCorrente = now.getMonth() + 1;
    const annoCorrente = now.getFullYear();

    const giocatori = fantaTeam.contratti.map((c) => {
      let anniRimanenti = c.durataContratto;
      if (c.dataFine && /^\d{2}-\d{4}$/.test(c.dataFine)) {
        const [mmFine, yyyyFine] = c.dataFine.split("-").map(Number);
        // Differenza in anni arrotondata per eccesso
        const diffMesi = (yyyyFine - annoCorrente) * 12 + (mmFine - meseCorrente);
        anniRimanenti = Math.max(0, Math.ceil(diffMesi / 12));
      }
      return {
        id: c.giocatore.id,
        nome: c.giocatore.nome,
        ruolo: c.giocatore.ruolo,
        squadra: c.giocatore.squadra,
        eta: c.giocatore.eta,
        valore: c.giocatore.valore ? +c.giocatore.valore : null,
        anniContratto: anniRimanenti,
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

    // anni rimanenti dal contratto dataFine (MM-YYYY)
    function anniRimanenti(dataFine) {
      if (!dataFine) return null;
      const [mm, yyyy] = dataFine.split("-").map(Number);
      if (!mm || !yyyy) return null;
      const diffMesi = (yyyy - now.getFullYear()) * 12 + (mm - (now.getMonth() + 1));
      return Math.max(0, Math.ceil(diffMesi / 12));
    }

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
