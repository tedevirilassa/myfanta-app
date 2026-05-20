// src/controllers/rinnovi.controller.js
const prisma = require("../lib/prisma");
const parametriService = require("../services/parametri.service");
const { logAction } = require("../services/log.service");

// ── Helpers ─────────────────────────────────────────────────────────────────

function stagioneCorrente(params) {
  const stagioneInizio = params.stagione_inizio || "01-07";
  const meseInizio = parseInt(stagioneInizio.split("-")[1], 10) || 7;
  const oggi = new Date();
  const meseOggi = oggi.getMonth() + 1;
  const anno = meseOggi >= meseInizio ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return { stagione: `${anno}-${anno + 1}`, annoInizio: anno, meseInizio };
}

function stagioneSuccessiva(stagione) {
  const [a] = stagione.split("-").map(Number);
  return `${a + 1}-${a + 2}`;
}

// Salary cap globale lega: (max + min)/2 * 25% del valore rosa (somma valore
// giocatori sotto contratto Acquisto valido), calcolato sui team con almeno
// un contratto valido. Restituisce valore in M€.
async function calcSalaryCapGlobale() {
  const teams = await prisma.fantaTeam.findMany({ select: { id: true } });
  const valori = [];
  for (const t of teams) {
    const contratti = await prisma.contratto.findMany({
      where: { fantaTeamId: t.id, valido: true, tipo: "Acquisto" },
      include: { giocatore: { select: { id: true, valore: true, active: true } } },
    });
    let rosa = 0;
    const seen = new Set();
    for (const c of contratti) {
      if (!c.giocatore.active) continue;
      if (seen.has(c.giocatoreId)) continue;
      seen.add(c.giocatoreId);
      rosa += c.giocatore.valore ? Number(c.giocatore.valore) : 0;
    }
    if (rosa > 0) valori.push(rosa);
  }
  if (valori.length === 0) return 0;
  const maxR = Math.max(...valori);
  const minR = Math.min(...valori);
  return Math.round(((maxR + minR) / 2) * 0.25 * 100) / 100;
}

// Contratti in scadenza = Acquisto valido con dataFine entro mese inizio
// prossima stagione (es. stagione corrente 2025-2026 → scadenze 07-2026).
async function findContrattiInScadenza(fantaTeamId, sCorrente) {
  const annoFineStagione = parseInt(sCorrente.stagione.split("-")[1], 10);
  const contratti = await prisma.contratto.findMany({
    where: { fantaTeamId, tipo: "Acquisto", valido: true },
    include: { giocatore: true },
    orderBy: { dataFine: "asc" },
  });
  return contratti.filter((c) => {
    if (!c.dataFine) return false;
    const yyyy = parseInt(c.dataFine.split("-")[1], 10);
    return Number.isFinite(yyyy) && yyyy <= annoFineStagione;
  });
}

// Marca le proposte come CONFERMATO/SVINCOLO in base a cap + cumulativa.
function simulateBudget(proposte, salaryCap) {
  let speso = 0;
  return proposte
    .slice()
    .sort((a, b) => a.ordinePriorita - b.ordinePriorita)
    .map((p) => {
      const ingaggio = Number(p.nuovoIngaggio);
      const sostenibile = speso + ingaggio <= salaryCap + 1e-9;
      if (sostenibile) speso += ingaggio;
      return {
        ...p,
        nuovoIngaggio: ingaggio,
        statoSimulato: sostenibile ? "CONFERMATO" : "SVINCOLO",
        budgetResiduoDopo: Math.round((salaryCap - speso) * 100) / 100,
      };
    });
}

async function findUserTeam(userId) {
  return prisma.fantaTeam.findFirst({ where: { userId } });
}

// ── User views ─────────────────────────────────────────────────────────────

// GET /fanta/rinnovi
async function showMieProposte(req, res) {
  const params = await parametriService.getAll();
  const sCorrente = stagioneCorrente(params);
  const sTarget = stagioneSuccessiva(sCorrente.stagione);
  const team = await findUserTeam(req.user.id);

  if (!team) {
    return res.render("fanta/rinnovi-mie", {
      currentUser: req.user, team: null, sCorrente, sTarget,
      contrattiInScadenza: [], propostePendenti: [], salaryCap: 0,
      error: "Nessun FantaTeam collegato al tuo utente.", message: null,
      params,
    });
  }

  const [contrattiInScadenza, propostePendenti, salaryCap] = await Promise.all([
    findContrattiInScadenza(team.id, sCorrente),
    prisma.propostaRinnovo.findMany({
      where: { fantaTeamId: team.id, stagione: sTarget, status: "PENDING" },
      include: { giocatore: true, contratto: true },
      orderBy: { ordinePriorita: "asc" },
    }),
    calcSalaryCapGlobale(),
  ]);

  // Contratti senza proposta ancora creata
  const idPropostiSet = new Set(propostePendenti.map((p) => p.contrattoId));
  const contrattiDisponibili = contrattiInScadenza.filter((c) => !idPropostiSet.has(c.id));

  const propostaSim = simulateBudget(propostePendenti, salaryCap);

  res.render("fanta/rinnovi-mie", {
    currentUser: req.user,
    team, sCorrente, sTarget, salaryCap, params,
    contrattiInScadenza, contrattiDisponibili,
    proposte: propostaSim,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
    message: req.query.saved === "1" ? "Proposta salvata."
           : req.query.deleted === "1" ? "Proposta rimossa."
           : req.query.reordered === "1" ? "Priorità aggiornata."
           : null,
  });
}

// POST /fanta/rinnovi/proposte  (form)
async function createProposta(req, res) {
  const { contrattoId, nuovaDurata, nuovoIngaggio } = req.body;
  const params = await parametriService.getAll();
  const sCorrente = stagioneCorrente(params);
  const sTarget = stagioneSuccessiva(sCorrente.stagione);
  const team = await findUserTeam(req.user.id);

  if (!team) return res.redirect("/fanta/rinnovi?error=" + encodeURIComponent("Nessun team collegato."));

  const cId = parseInt(contrattoId, 10);
  const durata = parseInt(nuovaDurata, 10);
  const ingaggio = parseFloat(nuovoIngaggio);

  const errors = [];
  if (!Number.isFinite(cId)) errors.push("Contratto non valido.");
  const dMin = params.contratto_durata_min ? Number(params.contratto_durata_min) : 1;
  const dMax = params.contratto_durata_max ? Number(params.contratto_durata_max) : 3;
  if (!Number.isFinite(durata) || durata < dMin || durata > dMax) {
    errors.push(`Durata deve essere tra ${dMin} e ${dMax} anni.`);
  }
  if (!Number.isFinite(ingaggio) || ingaggio <= 0) errors.push("Ingaggio mancante o non valido.");

  if (errors.length === 0) {
    const contratto = await prisma.contratto.findUnique({
      where: { id: cId }, include: { giocatore: true },
    });
    if (!contratto)                          errors.push("Contratto non trovato.");
    else if (contratto.fantaTeamId !== team.id) errors.push("Contratto non appartiene al tuo team.");
    else if (contratto.tipo !== "Acquisto")  errors.push("Rinnovo ammesso solo per contratti Acquisto.");
    else if (!contratto.valido)              errors.push("Contratto non più valido.");

    if (errors.length === 0) {
      const dupExist = await prisma.propostaRinnovo.findUnique({
        where: { contrattoId: cId },
      });
      if (dupExist) errors.push("Esiste già una proposta per questo contratto.");
    }

    if (errors.length === 0) {
      const ultimaPriorita = await prisma.propostaRinnovo.findFirst({
        where: { fantaTeamId: team.id, stagione: sTarget },
        orderBy: { ordinePriorita: "desc" },
      });
      const ordine = (ultimaPriorita?.ordinePriorita || 0) + 1;

      const nuova = await prisma.propostaRinnovo.create({
        data: {
          contrattoId: cId,
          fantaTeamId: team.id,
          giocatoreId: contratto.giocatoreId,
          stagione: sTarget,
          nuovaDurata: durata,
          nuovoIngaggio: ingaggio,
          ordinePriorita: ordine,
          status: "PENDING",
        },
      });
      await logAction({
        azione: "CREATE", entita: "proposta_rinnovo", entitaId: nuova.id,
        dettaglio: { dopo: { fantaTeamId: team.id, contrattoId: cId, giocatoreId: contratto.giocatoreId, stagione: sTarget, durata, ingaggio, ordine } },
        adminId: req.user.id,
      });
      return res.redirect("/fanta/rinnovi?saved=1");
    }
  }
  res.redirect("/fanta/rinnovi?error=" + encodeURIComponent(errors.join(" ")));
}

// DELETE /fanta/rinnovi/proposte/:id
async function deleteProposta(req, res) {
  const id = parseInt(req.params.id, 10);
  const team = await findUserTeam(req.user.id);
  if (!team) return res.redirect("/fanta/rinnovi?error=" + encodeURIComponent("Team non trovato."));
  const p = await prisma.propostaRinnovo.findUnique({ where: { id } });
  if (!p || p.fantaTeamId !== team.id) {
    return res.redirect("/fanta/rinnovi?error=" + encodeURIComponent("Proposta non trovata."));
  }
  if (p.status !== "PENDING") {
    return res.redirect("/fanta/rinnovi?error=" + encodeURIComponent("Proposta già finalizzata, non eliminabile."));
  }
  await prisma.propostaRinnovo.delete({ where: { id } });
  await logAction({
    azione: "DELETE", entita: "proposta_rinnovo", entitaId: id,
    dettaglio: { prima: { fantaTeamId: p.fantaTeamId, contrattoId: p.contrattoId, ordinePriorita: p.ordinePriorita } },
    adminId: req.user.id,
  });
  // Compatta ordinePriorita (1..N) per team+stagione
  await renumber(p.fantaTeamId, p.stagione);
  res.redirect("/fanta/rinnovi?deleted=1");
}

async function renumber(fantaTeamId, stagione) {
  const lista = await prisma.propostaRinnovo.findMany({
    where: { fantaTeamId, stagione, status: "PENDING" },
    orderBy: { ordinePriorita: "asc" },
  });
  // Strategia: prima sposto tutti in negativo per evitare collisione con UNIQUE,
  // poi assegno valori positivi finali.
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < lista.length; i++) {
      await tx.propostaRinnovo.update({
        where: { id: lista[i].id },
        data: { ordinePriorita: -(i + 1) },
      });
    }
    for (let i = 0; i < lista.length; i++) {
      await tx.propostaRinnovo.update({
        where: { id: lista[i].id },
        data: { ordinePriorita: i + 1 },
      });
    }
  });
}

// POST /fanta/rinnovi/proposte/ordina  (body: { ids: [int,int,...] })
async function reorderProposte(req, res) {
  const team = await findUserTeam(req.user.id);
  if (!team) return res.status(403).json({ error: "Team non trovato." });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => parseInt(x, 10)) : null;
  if (!ids || ids.some((x) => !Number.isFinite(x))) return res.status(400).json({ error: "ids non validi." });

  const proposte = await prisma.propostaRinnovo.findMany({
    where: { id: { in: ids }, fantaTeamId: team.id, status: "PENDING" },
  });
  if (proposte.length !== ids.length) {
    return res.status(400).json({ error: "Alcune proposte non sono tue o non sono PENDING." });
  }
  const stagione = proposte[0].stagione;
  if (proposte.some((p) => p.stagione !== stagione)) {
    return res.status(400).json({ error: "Proposte di stagioni diverse non mescolabili." });
  }

  // Reorder: prima negativi, poi positivi (evita collisione UNIQUE).
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.propostaRinnovo.update({ where: { id: ids[i] }, data: { ordinePriorita: -(i + 1) } });
    }
    for (let i = 0; i < ids.length; i++) {
      await tx.propostaRinnovo.update({ where: { id: ids[i] }, data: { ordinePriorita: i + 1 } });
    }
  });

  // Risimula budget post-reorder e ritorna stato aggiornato
  const aggiornate = await prisma.propostaRinnovo.findMany({
    where: { fantaTeamId: team.id, stagione, status: "PENDING" },
    orderBy: { ordinePriorita: "asc" },
    include: { giocatore: { select: { id: true, nome: true, ruolo: true, valore: true } } },
  });
  const cap = await calcSalaryCapGlobale();
  const sim = simulateBudget(aggiornate, cap);
  await logAction({
    azione: "UPDATE", entita: "proposta_rinnovo", entitaId: null,
    dettaglio: { tipo: "reorder", fantaTeamId: team.id, stagione, ordine: ids },
    adminId: req.user.id,
  });
  res.json({ salaryCap: cap, proposte: sim });
}

// GET /fanta/rinnovi/pubblico  (vista trasparenza di lega)
async function showRinnoviPubblico(req, res) {
  const params = await parametriService.getAll();
  const sCorrente = stagioneCorrente(params);
  const sTarget = stagioneSuccessiva(sCorrente.stagione);
  const cap = await calcSalaryCapGlobale();

  const allProposte = await prisma.propostaRinnovo.findMany({
    where: { stagione: sTarget },
    include: { giocatore: true, fantaTeam: true },
    orderBy: [{ fantaTeamId: "asc" }, { ordinePriorita: "asc" }],
  });
  // Raggruppa per team con simulazione per ciascuno
  const byTeam = new Map();
  for (const p of allProposte) {
    if (!byTeam.has(p.fantaTeamId)) byTeam.set(p.fantaTeamId, { team: p.fantaTeam, lista: [] });
    byTeam.get(p.fantaTeamId).lista.push(p);
  }
  const teams = Array.from(byTeam.values()).map((g) => ({
    team: g.team,
    proposte: simulateBudget(g.lista, cap),
  }));
  teams.sort((a, b) => (a.team.nome || "").localeCompare(b.team.nome || ""));

  res.render("fanta/rinnovi-pubblico", {
    currentUser: req.user, teams, salaryCap: cap, sTarget, sCorrente, params,
  });
}

// ── Admin views ────────────────────────────────────────────────────────────

// GET /admin/rinnovi
async function showAdminRinnovi(req, res) {
  const params = await parametriService.getAll();
  const sCorrente = stagioneCorrente(params);
  const sTarget = stagioneSuccessiva(sCorrente.stagione);
  const cap = await calcSalaryCapGlobale();

  const allProposte = await prisma.propostaRinnovo.findMany({
    where: { stagione: sTarget },
    include: { giocatore: true, fantaTeam: true, contratto: true },
    orderBy: [{ fantaTeamId: "asc" }, { ordinePriorita: "asc" }],
  });
  const byTeam = new Map();
  for (const p of allProposte) {
    if (!byTeam.has(p.fantaTeamId)) byTeam.set(p.fantaTeamId, { team: p.fantaTeam, lista: [] });
    byTeam.get(p.fantaTeamId).lista.push(p);
  }
  const teams = Array.from(byTeam.values()).map((g) => ({
    team: g.team,
    proposte: simulateBudget(g.lista, cap),
  }));
  teams.sort((a, b) => (a.team.nome || "").localeCompare(b.team.nome || ""));

  const stato = req.query.error ? null
              : req.query.finalized === "1" ? "Rinnovi finalizzati." : null;

  res.render("admin/rinnovi", {
    currentUser: req.user, teams, salaryCap: cap, sTarget, sCorrente, params,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
    message: stato,
    finalizzazionePossibile: allProposte.some((p) => p.status === "PENDING"),
  });
}

// POST /admin/rinnovi/finalizza
// Per ogni team, itera proposte PENDING ordinePriorita asc.
//  - Se nuovoIngaggio cumulativo ≤ cap: APPROVED → chiude vecchio + crea nuovo Acquisto + aggiorna SF.
//  - Else: REJECTED → svincolo + rimborso crediti = giocatore.valore corrente.
// Tutto atomico via $transaction.
async function finalizzaRinnovi(req, res) {
  const params = await parametriService.getAll();
  const sCorrente = stagioneCorrente(params);
  const sTarget = stagioneSuccessiva(sCorrente.stagione);
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const annoStipulaNuova = parseInt(sTarget.split("-")[0], 10); // es. 2026-2027 → 2026
  const dataStipulaNuova = `${String(meseInizio).padStart(2, "0")}-${annoStipulaNuova}`;

  try {
    const cap = await calcSalaryCapGlobale();
    if (cap <= 0) {
      return res.redirect("/admin/rinnovi?error=" + encodeURIComponent("Salary cap non calcolabile (rose vuote)."));
    }

    const teams = await prisma.fantaTeam.findMany({ include: { user: true } });
    const risultati = [];

    for (const team of teams) {
      const pendenti = await prisma.propostaRinnovo.findMany({
        where: { fantaTeamId: team.id, stagione: sTarget, status: "PENDING" },
        orderBy: { ordinePriorita: "asc" },
        include: { contratto: true, giocatore: true },
      });
      if (pendenti.length === 0) continue;

      let speso = 0;
      const approvati = [];
      const rifiutati = [];
      for (const p of pendenti) {
        const ing = Number(p.nuovoIngaggio);
        if (speso + ing <= cap + 1e-9) { approvati.push(p); speso += ing; }
        else rifiutati.push(p);
      }

      // Trova SF target del team per stagione corrente (svincolo) e prossima (nuovo contratto).
      // Strategia: i movimenti finanziari del rinnovo agiscono sulla SF della stagione di destinazione.
      const presidenteNome = team.user ? (team.user.nickname || team.user.email) : null;
      let sfTarget = await prisma.situazioneFinanziaria.findFirst({
        where: { fantaTeamId: team.id, stagione: sTarget },
      });
      if (!sfTarget && presidenteNome) {
        sfTarget = await prisma.situazioneFinanziaria.findFirst({
          where: { nomePresidente: presidenteNome, stagione: sTarget },
        });
      }
      if (!sfTarget) {
        risultati.push({ team: team.nome, errore: `SF stagione ${sTarget} mancante; skip team.` });
        continue;
      }

      await prisma.$transaction(async (tx) => {
        let crediti    = Number(sfTarget.crediti);
        let patrimonio = Number(sfTarget.patrimonio);
        let stipendi   = Number(sfTarget.stipendi);

        for (const p of approvati) {
          // Chiudi vecchio contratto Acquisto
          await tx.contratto.update({
            where: { id: p.contrattoId },
            data:  { valido: false },
          });
          // Crea nuovo Acquisto stagione successiva
          const destinazione = presidenteNome || `team#${team.id}`;
          const annoFine = annoStipulaNuova + p.nuovaDurata;
          const nuovoContratto = await tx.contratto.create({
            data: {
              tipo: "Acquisto",
              clausola: null,
              dataStipula: dataStipulaNuova,
              durataContratto: p.nuovaDurata,
              dataFine: `${String(meseInizio).padStart(2, "0")}-${annoFine}`,
              giocatoreId: p.giocatoreId,
              fantaTeamId: team.id,
              valoreGiocatore: p.giocatore.valore,
              importoOperazione: p.nuovoIngaggio,
              prezzoAcquisto: null,
              provenienza: "Rinnovo",
              destinazione,
              valido: true,
            },
          });
          // SF: stipendi += ingaggio (carico stagionale), crediti -= ingaggio, patrimonio -= ingaggio
          const ing = Number(p.nuovoIngaggio);
          const cPrima = crediti, pPrima = patrimonio, sPrima = stipendi;
          crediti    = Math.round((crediti    - ing) * 100) / 100;
          patrimonio = Math.round((patrimonio - ing) * 100) / 100;
          stipendi   = Math.round((stipendi   + ing) * 100) / 100;
          await tx.propostaRinnovo.update({
            where: { id: p.id },
            data:  {
              status: "APPROVED",
              motivoStato: `Rinnovato a ${ing.toFixed(2)} M (priorità ${p.ordinePriorita}, totale impegnato ${speso.toFixed(2)}/${cap.toFixed(2)}).`,
            },
          });
          await logAction({
            azione: "UPDATE", entita: "proposta_rinnovo", entitaId: p.id,
            dettaglio: {
              tipo: "finalize-approved",
              fantaTeamId: team.id, contrattoVecchioId: p.contrattoId, contrattoNuovoId: nuovoContratto.id,
              ingaggio: ing, durata: p.nuovaDurata,
              crediti: { prima: cPrima, dopo: crediti },
              patrimonio: { prima: pPrima, dopo: patrimonio },
              stipendi: { prima: sPrima, dopo: stipendi },
            },
            adminId: req.user.id,
          });
        }

        for (const p of rifiutati) {
          // Svincolo: chiudi vecchio contratto, rimborso = giocatore.valore (TM corrente)
          const giocatore = await tx.giocatore.findUnique({ where: { id: p.giocatoreId }, select: { valore: true } });
          const rimborso = giocatore?.valore ? Number(giocatore.valore) : 0;
          await tx.contratto.update({
            where: { id: p.contrattoId },
            data:  { valido: false },
          });
          const cPrima = crediti, pPrima = patrimonio;
          crediti    = Math.round((crediti    + rimborso) * 100) / 100;
          patrimonio = Math.round((patrimonio + rimborso) * 100) / 100;
          await tx.propostaRinnovo.update({
            where: { id: p.id },
            data:  {
              status: "REJECTED",
              motivoStato: `Svincolato (budget esaurito a priorità ${p.ordinePriorita}). Rimborso ${rimborso.toFixed(2)} M sui crediti.`,
            },
          });
          await logAction({
            azione: "UPDATE", entita: "proposta_rinnovo", entitaId: p.id,
            dettaglio: {
              tipo: "finalize-rejected",
              fantaTeamId: team.id, contrattoVecchioId: p.contrattoId, giocatoreId: p.giocatoreId,
              rimborso,
              crediti: { prima: cPrima, dopo: crediti },
              patrimonio: { prima: pPrima, dopo: patrimonio },
            },
            adminId: req.user.id,
          });
        }

        await tx.situazioneFinanziaria.update({
          where: { id: sfTarget.id },
          data:  { crediti, patrimonio, stipendi },
        });
      }, { timeout: 30000 });

      risultati.push({
        team: team.nome,
        approvati: approvati.length,
        rifiutati: rifiutati.length,
      });
    }

    await logAction({
      azione: "UPDATE", entita: "rinnovi", entitaId: null,
      dettaglio: { tipo: "finalize-batch", stagione: sTarget, salaryCap: cap, risultati },
      adminId: req.user.id,
    });
    res.redirect("/admin/rinnovi?finalized=1");
  } catch (err) {
    res.redirect("/admin/rinnovi?error=" + encodeURIComponent("Finalizzazione fallita: " + err.message));
  }
}

module.exports = {
  showMieProposte,
  createProposta,
  deleteProposta,
  reorderProposte,
  showRinnoviPubblico,
  showAdminRinnovi,
  finalizzaRinnovi,
};
