// src/controllers/fanta.controller.js
const sheets = require("../services/sheets.service");
const prisma  = require("../lib/prisma");

async function showClassifica(req, res) {
  try {
    const data = await sheets.getRiepilogo();
    // ordina per patrimonio DESC
    const classifica = [...data.presidenti].sort((a, b) => b.patrimonio - a.patrimonio);
    res.render("fanta/classifica", { classifica, currentUser: req.user, error: null });
  } catch (err) {
    console.error("Sheets error:", err.message);
    res.render("fanta/classifica", { classifica: [], currentUser: req.user, error: err.message });
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
    const giocatori = await prisma.giocatore.findMany({
      orderBy: [{ ruolo: "asc" }, { nome: "asc" }],
    });

    // Valori distinti per i filtri dropdown
    const ruoliEstesi = [...new Set(giocatori.map(g => g.ruoloEsteso).filter(Boolean))].sort();
    const squadre     = [...new Set(giocatori.map(g => g.squadra).filter(Boolean))].sort();

    res.render("fanta/lista-giocatori", {
      giocatori, ruoliEstesi, squadre,
      currentUser: req.user,
      error: null,
    });
  } catch (err) {
    console.error("DB error:", err.message);
    res.render("fanta/lista-giocatori", {
      giocatori: [], ruoliEstesi: [], squadre: [],
      currentUser: req.user,
      error: err.message,
    });
  }
}

module.exports = { showClassifica, showRiepilogo, showPresidente, showFinanze, showDiario, showLog, showGiocatori, showListaGiocatori };
