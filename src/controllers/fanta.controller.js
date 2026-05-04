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

    const stagioneFiltro = req.query.stagione || stagioni[0]?.stagione || null;

    const rawRecords = stagioneFiltro
      ? await prisma.situazioneFinanziaria.findMany({
          where: { stagione: stagioneFiltro },
          orderBy: { patrimonio: "desc" },
          include: { fantaTeam: true },
        })
      : [];

    // Converte Decimal → Number una sola volta
    const classifica = rawRecords.map((p) => ({
      ...p,
      valoreRose:      +p.valoreRose,
      crediti:         +p.crediti,
      patrimonio:      +p.patrimonio,
      etaMedia:        +p.etaMedia,
      stipendi:        +p.stipendi,
      montePrestiti:   +p.montePrestiti,
      ultimoPlusMinus: +p.ultimoPlusMinus,
    }));

    res.render("fanta/classifica", {
      classifica,
      stagioneFiltro,
      stagioni: stagioni.map((s) => s.stagione),
      currentUser: req.user,
      error: null,
    });
  } catch (err) {
    console.error("showClassifica error:", err.message);
    res.render("fanta/classifica", {
      classifica: [],
      stagioneFiltro: null,
      stagioni: [],
      currentUser: req.user,
      error: "Errore nel caricamento dei dati: " + err.message,
    });
  }
}

async function showRiepilogo(req, res) {
  try {
    const data = await sheets.getRiepilogo();
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
    const squadre     = [...new Set(giocatori.map(g => g.squadra).filter(Boolean))].sort();

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

module.exports = { showClassifica, showRiepilogo, showPresidente, showFinanze, showDiario, showLog, showGiocatori, showListaGiocatori, showRose };

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
