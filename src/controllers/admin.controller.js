// src/controllers/admin.controller.js
const prisma = require("../lib/prisma");
const authService = require("../services/auth.service");
const { logAction } = require("../services/log.service");
const { cleanNickname } = require("../lib/sanitize");
const parametriService = require("../services/parametri.service");
const { syncQuotazioni: runSyncQuotazioni } = require("../services/sync-quotazioni.service");
const { scrapeSerieA, SERIE_A_TEAMS, scrapeSquadFromBrowser, createBrowser, slugifyRuolo } = require("../services/transfermarkt.service");
const { spawn } = require("child_process");
const path = require("path");

const DEFAULT_PASSWORD = "primalogin2026";

// GET /admin/users
async function listUsers(req, res) {
  const [users, tuttiTeam, giocatoriIncompleti] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { fantaTeam: true } }),
    prisma.fantaTeam.findMany({ orderBy: { nome: "asc" } }),
    prisma.giocatore.findMany({
      where: { OR: [{ squadra: null }, { squadra: "" }, { eta: null }, { valore: null }] },
      orderBy: { nome: "asc" },
    }),
  ]);
  const reset = req.query.reset === "1";
  res.render("admin/users", {
    users,
    tuttiTeam,
    giocatoriIncompleti,
    currentUser: req.user,
    message: reset                  ? "Password reimpostata. L'utente dovrà cambiarla al prossimo accesso."
           : req.query.roleSaved    ? "Ruolo aggiornato con successo."
           : req.query.teamAssigned ? "FantaTeam assegnato con successo."
           : req.query.fieldSaved   ? "Dati utente aggiornati con successo."
           : req.query.userDeleted  ? "Utente eliminato con successo."
           : null,
    roleError: req.query.roleError || null,
    error: req.query.teamError   ? decodeURIComponent(req.query.teamError)
         : req.query.fieldError  ? decodeURIComponent(req.query.fieldError)
         : req.query.deleteError ? decodeURIComponent(req.query.deleteError)
         : null,
  });
}

// POST /admin/users/:id/toggle
async function toggleActive(req, res) {
  const id = parseInt(req.params.id, 10);

  if (id === req.user.id) {
    const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
    return res.render("admin/users", {
      users,
      currentUser: req.user,
      error: "Non puoi disabilitare il tuo account.",
      message: null,
    });
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.redirect("/admin/users");

  await prisma.user.update({ where: { id }, data: { isActive: !user.isActive } });
  await logAction({ azione: "UPDATE", entita: "utente", entitaId: id,
    dettaglio: {
      prima: { isActive: user.isActive },
      dopo:  { isActive: !user.isActive },
    },
    adminId: req.user.id });
  res.redirect("/admin/users");
}

// POST /admin/users/:id/delete
async function deleteUser(req, res) {
  const id = parseInt(req.params.id, 10);

  if (id === req.user.id) {
    return res.redirect("/admin/users?deleteError=" + encodeURIComponent("Non puoi eliminare il tuo account."));
  }

  const user = await prisma.user.findUnique({ where: { id }, include: { fantaTeam: true } });
  if (!user) return res.redirect("/admin/users");

  await prisma.$transaction(async (tx) => {
    // Disconnect FantaTeam
    if (user.fantaTeam) {
      await tx.fantaTeam.update({ where: { id: user.fantaTeam.id }, data: { userId: null } });
    }
    // Nullify invitedById for users invited by this user
    await tx.user.updateMany({ where: { invitedById: id }, data: { invitedById: null } });
    // Delete logs authored by this user
    await tx.log.deleteMany({ where: { adminId: id } });
    // Delete the user
    await tx.user.delete({ where: { id } });
  });

  await logAction({ azione: "DELETE", entita: "utente", entitaId: id,
    dettaglio: { prima: { email: user.email, nickname: user.nickname, role: user.role }, dopo: null },
    adminId: req.user.id });

  res.redirect("/admin/users?userDeleted=1");
}

// POST /admin/users/:id/reset-password
async function resetPassword(req, res) {
  const id = parseInt(req.params.id, 10);
  const userPre = await prisma.user.findUnique({ where: { id }, select: { email: true, mustChangePassword: true } });
  const hash = await authService.hashPassword(DEFAULT_PASSWORD);
  await prisma.user.update({
    where: { id },
    data: { passwordHash: hash, mustChangePassword: true },
  });
  await logAction({ azione: "UPDATE", entita: "utente", entitaId: id,
    dettaglio: {
      prima: { email: userPre?.email, mustChangePassword: userPre?.mustChangePassword },
      dopo:  { email: userPre?.email, mustChangePassword: true, note: "password reimpostata" },
    },
    adminId: req.user.id });
  res.redirect("/admin/users?reset=1");
}

// GET /admin/users/invite
function showInvite(req, res) {
  res.render("admin/invite", { error: null, message: null, currentUser: req.user });
}

// POST /admin/users/invite
async function inviteUser(req, res) {
  const { email, role } = req.body;

  if (!email || !role) {
    return res.render("admin/invite", {
      error: "Email e ruolo sono obbligatori.",
      message: null,
      currentUser: req.user,
    });
  }

  const validRoles = ["ADMIN", "USER", "POWER_USER"];
  if (!validRoles.includes(role)) {
    return res.render("admin/invite", {
      error: "Ruolo non valido.",
      message: null,
      currentUser: req.user,
    });
  }

  const existing = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  if (existing) {
    return res.render("admin/invite", {
      error: "Un utente con questa email esiste già.",
      message: null,
      currentUser: req.user,
    });
  }

  const hash = await authService.hashPassword(DEFAULT_PASSWORD);
  const newUser = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      passwordHash: hash,
      role,
      mustChangePassword: true,
      invitedById: req.user.id,
    },
  });
  await logAction({ azione: "CREATE", entita: "utente", entitaId: newUser.id,
    dettaglio: {
      prima: null,
      dopo:  { email: newUser.email, role, mustChangePassword: true },
    },
    adminId: req.user.id });

  return res.render("admin/invite", {
    message: `Utente ${email} creato con successo. Comunicagli la password predefinita: ${DEFAULT_PASSWORD}`,
    error: null,
    currentUser: req.user,
  });
}

// GET /admin/users/:id/edit-profile
async function showEditProfile(req, res) {
  const id = parseInt(req.params.id, 10);
  const user = await prisma.user.findUnique({ where: { id }, include: { fantaTeam: true } });
  if (!user) return res.redirect("/admin/users");
  res.render("admin/edit-profile", {
    editUser: user,
    currentUser: req.user,
    success: null,
    error: null,
  });
}

// POST /admin/users/:id/edit-profile
async function saveEditProfile(req, res) {
  const id = parseInt(req.params.id, 10);
  const user = await prisma.user.findUnique({ where: { id }, include: { fantaTeam: true } });
  if (!user) return res.redirect("/admin/users");

  const nick = cleanNickname(req.body.nickname);
  const team = (req.body.teamName  || "").trim().slice(0, 60);

  try {
    const prima = { nickname: user.nickname, teamName: user.fantaTeam?.nome };

    const updated = await prisma.user.update({
      where: { id },
      data: { nickname: nick },
      include: { fantaTeam: true },
    });

    // Aggiorna il nome del fantaTeam se esiste
    if (updated.fantaTeam && team) {
      await prisma.fantaTeam.update({
        where: { id: updated.fantaTeam.id },
        data: { nome: team },
      });
      updated.fantaTeam.nome = team;
    }

    await logAction({
      azione: "UPDATE", entita: "utente", entitaId: id,
      dettaglio: { prima, dopo: { nickname: nick, teamName: team || prima.teamName } },
      adminId: req.user.id,
    });

    res.render("admin/edit-profile", {
      editUser: updated,
      currentUser: req.user,
      success: "Profilo aggiornato con successo.",
      error: null,
    });
  } catch (err) {
    console.error("Admin edit-profile error:", err.message);
    res.render("admin/edit-profile", {
      editUser: user,
      currentUser: req.user,
      success: null,
      error: "Errore durante il salvataggio. Riprova.",
    });
  }
}

// POST /admin/users/:id/change-role
async function changeRole(req, res) {
  const id = parseInt(req.params.id, 10);

  if (id === req.user.id) {
    return res.redirect("/admin/users?roleError=self");
  }

  const { role } = req.body;
  const validRoles = ["ADMIN", "USER", "POWER_USER"];
  if (!validRoles.includes(role)) {
    return res.redirect("/admin/users?roleError=invalid");
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.redirect("/admin/users");

  await prisma.user.update({ where: { id }, data: { role } });
  await logAction({
    azione: "UPDATE",
    entita: "utente",
    entitaId: id,
    dettaglio: { prima: { role: user.role }, dopo: { role } },
    adminId: req.user.id,
  });

  res.redirect("/admin/users?roleSaved=1");
}

// POST /admin/fanta-teams/:id/assign
async function assignFantaTeam(req, res) {
  const teamId = parseInt(req.params.id, 10);
  const userId = parseInt(req.body.userId, 10);

  if (!userId) {
    return res.redirect("/admin/users?teamError=" + encodeURIComponent("Seleziona un presidente."));
  }

  // Verifica che il team esista e sia senza owner
  const team = await prisma.fantaTeam.findUnique({ where: { id: teamId } });
  if (!team) {
    return res.redirect("/admin/users?teamError=" + encodeURIComponent("FantaTeam non trovato."));
  }
  if (team.userId !== null) {
    return res.redirect("/admin/users?teamError=" + encodeURIComponent("Questo FantaTeam è già assegnato a un utente."));
  }

  // Verifica che l'utente non abbia già un team
  const esistente = await prisma.fantaTeam.findFirst({ where: { userId } });
  if (esistente) {
    return res.redirect("/admin/users?teamError=" + encodeURIComponent("Questo presidente ha già un FantaTeam assegnato."));
  }

  await prisma.fantaTeam.update({ where: { id: teamId }, data: { userId } });
  await logAction({
    azione: "UPDATE",
    entita: "fantateam",
    entitaId: teamId,
    dettaglio: { prima: { userId: null }, dopo: { userId } },
    adminId: req.user.id,
  });

  res.redirect("/admin/users?teamAssigned=1");
}

// ── POST /admin/situazione-finanziaria/:id/crediti ────────────────────────────
async function adjustCrediti(req, res) {
  const id = parseInt(req.params.id, 10);
  const importo = parseFloat(req.body.importo);
  const motivo = (req.body.motivo || "").trim();

  if (isNaN(id)) {
    return res.redirect("/admin/situazione-finanziaria?error=" + encodeURIComponent("ID non valido."));
  }
  if (!importo || isNaN(importo)) {
    return res.redirect("/admin/situazione-finanziaria?error=" + encodeURIComponent("Importo non valido."));
  }

  const situazione = await prisma.situazioneFinanziaria.findUnique({ where: { id } });
  if (!situazione) {
    return res.redirect("/admin/situazione-finanziaria?error=" + encodeURIComponent("Record non trovato."));
  }

  const creditiPre = parseFloat(situazione.crediti);
  const nuoviCrediti = Math.round((creditiPre + importo) * 100) / 100;
  const patrimonioPre = parseFloat(situazione.patrimonio);
  const nuovoPatrimonio = Math.round((patrimonioPre + importo) * 100) / 100;

  await prisma.situazioneFinanziaria.update({
    where: { id },
    data: { crediti: nuoviCrediti, patrimonio: nuovoPatrimonio },
  });

  await logAction({
    azione: "UPDATE",
    entita: "situazione_finanziaria",
    entitaId: id,
    dettaglio: {
      operazione: "aggiustamento_crediti",
      importo,
      motivo: motivo || null,
      prima: { crediti: creditiPre, patrimonio: patrimonioPre },
      dopo:  { crediti: nuoviCrediti, patrimonio: nuovoPatrimonio },
    },
    adminId: req.user.id,
  });

  res.redirect("/admin/situazione-finanziaria?saved=1&adj=" + importo);
}

// ── POST /admin/sync-quotazioni (SSE streaming — vecchio endpoint) ─────────────
async function syncQuotazioni(req, res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
  };

  const squadraFiltro = (req.body && req.body.squadra) || null;

  try {
    const stats = await runSyncQuotazioni(send, squadraFiltro, req.user.id);
    send({ type: "done", stats });
  } catch (err) {
    send({ type: "error", msg: err.message });
  } finally {
    res.end();
  }
}

// ── GET /admin/sync-transfermarkt ────────────────────────────────────────────
async function showSyncTransfermarkt(req, res) {
  const catalogo = await parametriService.getSerieACatalogo() || SERIE_A_TEAMS;
  const activeTeamNames = await parametriService.getSerieATeamNames();
  const serieATeams = activeTeamNames || catalogo.map(t => t.nome);
  res.render("admin/sync-transfermarkt", { currentUser: req.user, serieATeams });
}

// ── POST /admin/sync-transfermarkt/scrape (SSE) ──────────────────────────────
// Esegue solo lo scraping + diff con DB; NON scrive nel DB.
// Emette eventi SSE e alla fine un evento "done" con l'array preview.
async function runScrapeTransfermarkt(req, res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
  };

  const { squadra } = req.body; // null = tutte

  try {
    // Determina catalogo squadre (DB o hardcoded) e filtra per quelle attive
    const catalogo = await parametriService.getSerieACatalogo() || SERIE_A_TEAMS;
    const activeTeamNames = await parametriService.getSerieATeamNames();
    const baseTeams = activeTeamNames
      ? catalogo.filter(t => activeTeamNames.includes(t.nome))
      : catalogo;

    // Filtra squadre se richiesto
    const teamsFiltrati = squadra
      ? baseTeams.filter(t => t.nome === squadra)
      : baseTeams;

    if (teamsFiltrati.length === 0) {
      send({ type: "error", msg: `Squadra "${squadra}" non trovata nella lista.` });
      return res.end();
    }

    send({ type: "log", msg: `🚀 Scraping ${teamsFiltrati.length} squadra/e…` });

    const ruoliMap = await parametriService.getRuoliTM();
    const browser  = await createBrowser();

    // Se scraping "tutte", identifica le squadre già scrapate oggi e saltale
    const oggi = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    let squadreGiaScrape = new Set();
    if (!squadra) {
      const quotazioniOggi = await prisma.quotazione.findMany({
        where: { createdAt: { gte: new Date(oggi + "T00:00:00Z") } },
        select: { giocatore: { select: { squadra: true } } },
      });
      quotazioniOggi.forEach(q => {
        if (q.giocatore?.squadra) squadreGiaScrape.add(q.giocatore.squadra);
      });
    }

    // Raccoglie tutti i giocatori scrapati con il team associato
    const allScraped = [];
    const errori = [];

    const RETRY_MAX   = 3;
    const RETRY_DELAY = 10_000;

    for (const team of teamsFiltrati) {
      // Salta squadre già scrapate oggi (solo in modalità "tutte")
      if (!squadra && squadreGiaScrape.has(team.nome)) {
        send({ type: "log", msg: `⏭ ${team.nome}: già scrapata oggi, salto.` });
        continue;
      }

      send({ type: "log", msg: `[TM] Scraping ${team.nome}…` });

      let players = null;
      let lastErr = null;

      for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
        try {
          players = await scrapeSquadFromBrowser(browser, team, (msg) => send({ type: "log", msg }), ruoliMap);
          lastErr = null;
          break; // successo
        } catch (err) {
          lastErr = err;
          if (attempt < RETRY_MAX) {
            send({ type: "warn", msg: `  ↺ ${team.nome}: tentativo ${attempt}/${RETRY_MAX} fallito (${err.message}). Nuovo tentativo in ${RETRY_DELAY / 1000}s…` });
            await new Promise(r => setTimeout(r, RETRY_DELAY));
          }
        }
      }

      if (players === null || lastErr) {
        errori.push(team.nome);
        const errMsg = lastErr ? lastErr.message : "errore scraping";
        send({ type: "warn", msg: `  ✗ ${team.nome}: tutti i ${RETRY_MAX} tentativi falliti. Ultimo errore: ${errMsg}` });
      } else {
        allScraped.push(...players);
        send({ type: "scraped", team: team.nome, players });
        const delay = 2000 + Math.floor(Math.random() * 2000);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    await browser.close();
    send({ type: "log", msg: `[TM] Browser chiuso.` });

    // Auto-registra ruoli sconosciuti nel DB (l'admin potrà configurarli)
    for (const p of allScraped) {
      if (p.ruoloEsteso) {
        const slug = slugifyRuolo(p.ruoloEsteso);
        if (!ruoliMap[slug]) {
          await parametriService.upsertRuoloTM(slug, p.ruoloEsteso);
          ruoliMap[slug] = 'C'; // evita doppie scritture nel loop
        }
      }
    }

    // ── Diff con DB ──────────────────────────────────────────────────────
    send({ type: "log", msg: `🔍 Confronto con il database…` });

    const preview = [];
    const STAGIONE_CORRENTE = "2025-2026";

    // Normalizza nome per matching
    function normName(s) {
      return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, "").trim();
    }

    // Giocatori DB per squadre coinvolte
    const squadreCoinvolte = [...new Set(allScraped.map(p => p.squadra))];
    const dbGiocatori = await prisma.giocatore.findMany({
      where: { squadra: { in: squadreCoinvolte } },
      select: { id: true, nome: true, squadra: true, valore: true, active: true, transfermarktId: true },
    });

    const dbByTmId   = new Map(dbGiocatori.filter(g => g.transfermarktId).map(g => [g.transfermarktId, g]));
    const dbByNomeSq = new Map(dbGiocatori.map(g => [`${normName(g.nome)}|${g.squadra}`, g]));
    const scrapatiIds = new Set();

    for (const p of allScraped) {
      let existing = p.transfermarktId ? dbByTmId.get(p.transfermarktId) : null;
      if (!existing) existing = dbByNomeSq.get(`${normName(p.nome)}|${p.squadra}`);

      if (existing) {
        scrapatiIds.add(existing.id);
        preview.push({ tipo: "update", dbId: existing.id, ...p, stagione: STAGIONE_CORRENTE });
      } else {
        preview.push({ tipo: "nuovo", dbId: null, ...p, stagione: STAGIONE_CORRENTE });
      }
    }

    // Inattivi: in DB attivi per questa squadra ma non trovati oggi
    for (const team of teamsFiltrati) {
      const attivi = dbGiocatori.filter(g => g.squadra === team.nome && g.active && !scrapatiIds.has(g.id));
      for (const g of attivi) {
        preview.push({ tipo: "inattivo", dbId: g.id, nome: g.nome, squadra: g.squadra, valore: g.valore ? Number(g.valore) : null, stagione: STAGIONE_CORRENTE });
      }
    }

    send({ type: "done", preview });

  } catch (err) {
    send({ type: "error", msg: err.message });
  } finally {
    res.end();
  }
}

// ── POST /admin/parametri/init-ruoli-tm ──────────────────────────────────────
async function initRuoliTM(req, res) {
  await parametriService.initRuoliTM();
  res.redirect("/admin/parametri?saved=1");
}

// ── POST /admin/sync-transfermarkt/import ────────────────────────────────────
// Riceve l'array players confermato dall'utente e lo persiste nel DB.
async function importTransfermarkt(req, res) {
  const { players } = req.body;

  if (!Array.isArray(players) || players.length === 0) {
    return res.status(400).json({ error: "Nessun giocatore da importare." });
  }

  const stats = { nuovi: 0, aggiornati: 0, inattivi: 0, quotazioni: 0, errori: 0 };
  const STAGIONE_CORRENTE = "2025-2026";

  for (const p of players) {
    try {
      if (p.tipo === "inattivo") {
        if (p.dbId) {
          await prisma.giocatore.update({ where: { id: p.dbId }, data: { active: false } });
          await logAction({ azione: "UPDATE", entita: "giocatore", entitaId: p.dbId, dettaglio: { prima: { active: true }, dopo: { active: false } }, adminId: req.user.id });
          stats.inattivi++;
        }
        continue;
      }

      if (p.tipo === "update" && p.dbId) {
        const updateData = {
          squadra:         p.squadra,
          valore:          p.valore,
          active:          true,
          ...(p.ruolo          && { ruolo: p.ruolo }),
          ...(p.ruoloEsteso    && { ruoloEsteso: p.ruoloEsteso }),
          ...(p.dataNascita    && { dataNascita: p.dataNascita }),
          ...(p.eta != null     && { eta: p.eta }),
          ...(p.transfermarktId && { transfermarktId: p.transfermarktId }),
        };
        await prisma.giocatore.update({ where: { id: p.dbId }, data: updateData });
        await prisma.quotazione.create({
          data: { giocatoreId: p.dbId, valore: p.valore, fonte: "transfermarkt", stagione: STAGIONE_CORRENTE },
        });
        await logAction({ azione: "UPDATE", entita: "giocatore", entitaId: p.dbId, dettaglio: { dopo: updateData }, adminId: req.user.id });
        stats.aggiornati++;
        stats.quotazioni++;

      } else if (p.tipo === "nuovo") {
        const g = await prisma.giocatore.create({
          data: {
            nome:            p.nome,
            ruolo:           p.ruolo || "C",
            ruoloEsteso:     p.ruoloEsteso   || null,
            squadra:         p.squadra,
            valore:          p.valore,
            dataNascita:     p.dataNascita   || null,
            eta:             p.eta           ?? null,
            transfermarktId: p.transfermarktId || null,
            active:          true,
          },
        });
        await prisma.quotazione.create({
          data: { giocatoreId: g.id, valore: p.valore, fonte: "transfermarkt", stagione: STAGIONE_CORRENTE },
        });
        await logAction({ azione: "CREATE", entita: "giocatore", entitaId: g.id, dettaglio: { dopo: { nome: p.nome, ruolo: p.ruolo, squadra: p.squadra, valore: p.valore } }, adminId: req.user.id });
        stats.nuovi++;
        stats.quotazioni++;
      }
    } catch (err) {
      stats.errori++;
    }
  }

  res.json(stats);
}

// ── GET /admin/realign-ruoli ─────────────────────────────────────────────────
// Mostra anteprima: per ogni giocatore con ruoloEsteso, ricalcola il ruolo P/D/C/A
// secondo la ruoliMap attuale e segnala i cambi. Nessuna scrittura.
async function showRealignRuoli(req, res) {
  const ruoliMap = await parametriService.getRuoliTM();

  const giocatori = await prisma.giocatore.findMany({
    where: { active: true },
    select: { id: true, nome: true, squadra: true, ruolo: true, ruoloEsteso: true },
    orderBy: [{ squadra: "asc" }, { nome: "asc" }],
  });

  const cambi = [];
  let invariati = 0;
  let senzaRuoloEsteso = 0;
  let mappingMancante = 0;

  for (const g of giocatori) {
    if (!g.ruoloEsteso) { senzaRuoloEsteso++; continue; }
    const slug = slugifyRuolo(g.ruoloEsteso);
    const nuovoRuolo = ruoliMap[slug];
    if (!nuovoRuolo) {
      mappingMancante++;
      cambi.push({ id: g.id, nome: g.nome, squadra: g.squadra, ruoloEsteso: g.ruoloEsteso, slug, ruoloAttuale: g.ruolo, ruoloNuovo: null, stato: "no_map" });
      continue;
    }
    if (nuovoRuolo !== g.ruolo) {
      cambi.push({ id: g.id, nome: g.nome, squadra: g.squadra, ruoloEsteso: g.ruoloEsteso, slug, ruoloAttuale: g.ruolo, ruoloNuovo: nuovoRuolo, stato: "cambio" });
    } else {
      invariati++;
    }
  }

  res.render("admin/realign-ruoli", {
    currentUser: req.user,
    cambi,
    totaleGiocatori: giocatori.length,
    invariati,
    senzaRuoloEsteso,
    mappingMancante,
    applied: req.query.applied || null,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
  });
}

// ── POST /admin/realign-ruoli/apply ──────────────────────────────────────────
// Applica i cambi di ruolo P/D/C/A in base alla ruoliMap corrente.
// Aggiorna solo giocatori il cui ruolo calcolato differisce da quello in DB.
async function applyRealignRuoli(req, res) {
  try {
    const ruoliMap = await parametriService.getRuoliTM();

    const giocatori = await prisma.giocatore.findMany({
      where: { active: true, NOT: { ruoloEsteso: null } },
      select: { id: true, ruolo: true, ruoloEsteso: true },
    });

    let aggiornati = 0;
    let skipNoMap = 0;

    for (const g of giocatori) {
      const slug = slugifyRuolo(g.ruoloEsteso);
      const nuovoRuolo = ruoliMap[slug];
      if (!nuovoRuolo) { skipNoMap++; continue; }
      if (nuovoRuolo === g.ruolo) continue;

      await prisma.giocatore.update({
        where: { id: g.id },
        data:  { ruolo: nuovoRuolo },
      });
      aggiornati++;
    }

    await logAction({
      azione:   "UPDATE",
      entita:   "giocatori",
      entitaId: null,
      dettaglio: { tipo: "realign-ruoli", aggiornati, skipNoMap, totaleScansionati: giocatori.length },
      adminId:  req.user.id,
    });

    res.redirect(`/admin/realign-ruoli?applied=${aggiornati}`);
  } catch (err) {
    res.redirect(`/admin/realign-ruoli?error=${encodeURIComponent(err.message)}`);
  }
}

module.exports = { listUsers, toggleActive, resetPassword, showInvite, inviteUser, showEditProfile, saveEditProfile, showPannello, inlineEditUser, runSeedGiocatori, showNuovoContratto, saveNuovoContratto, listContrattiRiepilogo, saveEditContratto, annullaContratto, listLog, changeRole, createGiocatore, updateGiocatore, deleteGiocatore, deleteUser, assignFantaTeam, listSituazioneFinanziaria, assignFantaTeamToSituazione, adjustCrediti, saveUserFields, listParametri, saveParametro, saveSerieATeams, addSerieATeam, removeSerieATeam, initRuoliTM, listRosa, showRosa, saveRosa, syncQuotazioni, showSyncTransfermarkt, runScrapeTransfermarkt, importTransfermarkt, showPremi, savePremi, showRealignRuoli, applyRealignRuoli };

// ── POST /admin/users/:id/save-fields ─────────────────────────────────────────────
async function saveUserFields(req, res) {
  const id = parseInt(req.params.id, 10);
  const email    = (req.body.email    || "").trim().toLowerCase();
  const nickname = cleanNickname(req.body.nickname);
  const fantaTeamId = req.body.fantaTeamId ? parseInt(req.body.fantaTeamId, 10) : null;

  if (!email) {
    return res.redirect("/admin/users?fieldError=" + encodeURIComponent("L'email è obbligatoria."));
  }

  // Verifica unicità email (escluso se stesso)
  const emailConflict = await prisma.user.findFirst({ where: { email, NOT: { id } } });
  if (emailConflict) {
    return res.redirect("/admin/users?fieldError=" + encodeURIComponent("Email già in uso da un altro utente."));
  }

  const user = await prisma.user.findUnique({ where: { id }, include: { fantaTeam: true } });
  if (!user) return res.redirect("/admin/users");

  const vecchioTeamId = user.fantaTeam?.id ?? null;

  // Gestione riassegnazione FantaTeam in transazione
  await prisma.$transaction(async (tx) => {
    if (fantaTeamId !== vecchioTeamId) {
      if (vecchioTeamId) {
        await tx.fantaTeam.update({ where: { id: vecchioTeamId }, data: { userId: null } });
      }
      if (fantaTeamId) {
        const targetTeam = await tx.fantaTeam.findUnique({ where: { id: fantaTeamId } });
        if (targetTeam && targetTeam.userId !== null && targetTeam.userId !== id) {
          throw new Error("FantaTeam gi\u00e0 assegnato a un altro utente.");
        }
        await tx.fantaTeam.update({ where: { id: fantaTeamId }, data: { userId: id } });
      }
    }
    await tx.user.update({
      where: { id },
      data: { email, nickname },
    });
  }).catch((err) => {
    return res.redirect("/admin/users?fieldError=" + encodeURIComponent(err.message));
  });

  await logAction({
    azione: "UPDATE",
    entita: "utente",
    entitaId: id,
    dettaglio: {
      prima: { email: user.email, nickname: user.nickname, fantaTeamId: vecchioTeamId },
      dopo:  { email, nickname, fantaTeamId },
    },
    adminId: req.user.id,
  });

  res.redirect("/admin/users?fieldSaved=1");
}

// ── GET /admin/situazione-finanziaria ────────────────────────────────────────
async function listSituazioneFinanziaria(req, res) {
  const situazioni = await prisma.situazioneFinanziaria.findMany({
    orderBy: [{ stagione: "desc" }, { nomePresidente: "asc" }],
  });

  const stagioni = [...new Set(situazioni.map((s) => s.stagione))].sort().reverse();

  res.render("admin/situazione-finanziaria", {
    situazioni,
    stagioni,
    currentUser: req.user,
    message: req.query.saved   === "1" ? "Crediti aggiornati."          : null,
    error:   req.query.error   ? decodeURIComponent(req.query.error) : null,
  });
}

// ── POST /admin/situazione-finanziaria/:id/assign ─────────────────────────────
async function assignFantaTeamToSituazione(req, res) {
  const id = parseInt(req.params.id, 10);
  const fantaTeamId = req.body.fantaTeamId ? parseInt(req.body.fantaTeamId, 10) : null;

  const situazione = await prisma.situazioneFinanziaria.findUnique({ where: { id } });
  if (!situazione) {
    return res.redirect("/admin/situazione-finanziaria?error=" + encodeURIComponent("Record non trovato."));
  }

  if (fantaTeamId) {
    const team = await prisma.fantaTeam.findUnique({ where: { id: fantaTeamId } });
    if (!team) {
      return res.redirect("/admin/situazione-finanziaria?error=" + encodeURIComponent("FantaTeam non trovato."));
    }
  }

  await prisma.situazioneFinanziaria.update({
    where: { id },
    data: { fantaTeamId: fantaTeamId },
  });

  await logAction({
    azione: "UPDATE",
    entita: "situazione_finanziaria",
    entitaId: id,
    dettaglio: {
      prima: { fantaTeamId: situazione.fantaTeamId },
      dopo:  { fantaTeamId },
    },
    adminId: req.user.id,
  });

  res.redirect("/admin/situazione-finanziaria?saved=1");
}

// ── POST /admin/giocatori (crea) ──────────────────────────────────────────────
async function createGiocatore(req, res) {
  const { nome, ruolo, ruoloEsteso, squadra, eta, valore, active } = req.body;

  if (!nome || !ruolo) {
    return res.redirect("/fanta/lista-giocatori?gError=missing");
  }
  const RUOLI = ["P", "D", "C", "A"];
  if (!RUOLI.includes(ruolo)) return res.redirect("/fanta/lista-giocatori?gError=invalid");

  const g = await prisma.giocatore.create({
    data: {
      nome: nome.trim(),
      ruolo,
      ruoloEsteso: ruoloEsteso?.trim() || null,
      squadra: squadra?.trim() || null,
      eta: eta ? parseInt(eta) : null,
      valore: valore ? parseFloat(valore) : null,
      active: active === "1",
    },
  });

  await logAction({ azione: "CREATE", entita: "giocatore", entitaId: g.id,
    dettaglio: { dopo: { nome: g.nome, ruolo: g.ruolo, squadra: g.squadra } },
    adminId: req.user.id });

  res.redirect("/fanta/lista-giocatori?gSaved=1");
}

// ── POST /admin/giocatori/:id (modifica) ──────────────────────────────────────
async function updateGiocatore(req, res) {
  const id = parseInt(req.params.id, 10);
  const { nome, ruolo, ruoloEsteso, squadra, eta, valore, active } = req.body;

  const pre = await prisma.giocatore.findUnique({ where: { id } });
  if (!pre) return res.redirect("/fanta/lista-giocatori?gError=notfound");

  const updated = await prisma.giocatore.update({
    where: { id },
    data: {
      nome: nome.trim(),
      ruolo,
      ruoloEsteso: ruoloEsteso?.trim() || null,
      squadra: squadra?.trim() || null,
      eta: eta ? parseInt(eta) : null,
      valore: valore ? parseFloat(valore) : null,
      active: active === "1",
    },
  });

  await logAction({ azione: "UPDATE", entita: "giocatore", entitaId: id,
    dettaglio: {
      prima: { nome: pre.nome, ruolo: pre.ruolo, squadra: pre.squadra, valore: pre.valore, active: pre.active },
      dopo:  { nome: updated.nome, ruolo: updated.ruolo, squadra: updated.squadra, valore: updated.valore, active: updated.active },
    },
    adminId: req.user.id });

  res.redirect("/fanta/lista-giocatori?gSaved=1");
}

// ── POST /admin/giocatori/:id/delete ──────────────────────────────────────────
async function deleteGiocatore(req, res) {
  const id = parseInt(req.params.id, 10);
  const g = await prisma.giocatore.findUnique({ where: { id } });
  if (!g) return res.redirect("/fanta/lista-giocatori?gError=notfound");

  // Controlla se ha contratti attivi
  const contratti = await prisma.contratto.count({ where: { giocatoreId: id } });
  if (contratti > 0) {
    return res.redirect(`/fanta/lista-giocatori?gError=hasContratti&nome=${encodeURIComponent(g.nome)}`);
  }

  await prisma.giocatore.delete({ where: { id } });
  await logAction({ azione: "DELETE", entita: "giocatore", entitaId: id,
    dettaglio: { prima: { nome: g.nome, ruolo: g.ruolo, squadra: g.squadra } },
    adminId: req.user.id });

  res.redirect("/fanta/lista-giocatori?gDeleted=1");
}

// ── GET /admin/contratti/riepilogo ────────────────────────────────────────────
async function listContrattiRiepilogo(req, res) {
  const contratti = await prisma.contratto.findMany({
    orderBy: { createdAt: "desc" },
    include: { giocatore: true, fantaTeam: true },
  });

  const annoCorrente = new Date().getFullYear();
  let scadenzaVicina = 0;
  let valoreTotal = 0;

  for (const c of contratti) {
    valoreTotal += parseFloat(c.valoreGiocatore || 0);
    if (c.dataFine) {
      const anno = parseInt(c.dataFine.split("-")[1]);
      if (anno <= annoCorrente) scadenzaVicina++;
    }
  }

  const teams = await prisma.fantaTeam.findMany({ orderBy: { nome: "asc" }, select: { id: true, nome: true } });

  res.render("admin/contratti-riepilogo", {
    contratti,
    teams,
    totaleContratti: contratti.length,
    scadenzaVicina,
    valoreTotal,
    currentUser: req.user,
    editSuccess: req.query.saved     === "1" ? "Contratto aggiornato con successo." :
                 req.query.deleted    === "1" ? "Contratto eliminato."              :
                 req.query.annullato         ? `Contratto #${req.query.annullato} annullato: saldi ripristinati, contratti precedenti rivalidati.` : null,
    editError:   req.query.error  ? decodeURIComponent(req.query.error)          : null,
  });
}

// ── GET /admin/pannello ───────────────────────────────────────────────────────
async function showPannello(req, res) {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { fantaTeam: true } });
  const catalogo = await parametriService.getSerieACatalogo() || SERIE_A_TEAMS;
  const activeTeamNames = await parametriService.getSerieATeamNames();
  const serieATeams = activeTeamNames || catalogo.map(t => t.nome);
  res.render("admin/pannello", {
    users,
    currentUser: req.user,
    serieATeams,
    message: req.query.saved ? "Profilo aggiornato." : null,
    error: null,
  });
}

// ── POST /admin/users/:id/inline-profile ─────────────────────────────────────
async function inlineEditUser(req, res) {
  const id = parseInt(req.params.id, 10);
  const nick = cleanNickname(req.body.nickname);
  const team = (req.body.teamName  || "").trim().slice(0, 60);
  try {
    const userPre = await prisma.user.findUnique({ where: { id }, select: { nickname: true } });
    const updated = await prisma.user.update({
      where: { id },
      data: { nickname: nick },
      include: { fantaTeam: true },
    });

    // Aggiorna il nome del fantaTeam se esiste
    if (updated.fantaTeam && team) {
      await prisma.fantaTeam.update({
        where: { id: updated.fantaTeam.id },
        data: { nome: team },
      });
    }

    await logAction({ azione: "UPDATE", entita: "utente", entitaId: id,
      dettaglio: {
        prima: { nickname: userPre?.nickname ?? null },
        dopo:  { nickname: nick },
      },
      adminId: req.user.id });
  } catch (err) {
    console.error("inlineEditUser error:", err.message);
  }
  res.redirect("/admin/pannello?saved=1");
}

// ── POST /admin/tools/seed-giocatori (JSON) ───────────────────────────────────
function runSeedGiocatori(req, res) {
  const seedPath = path.join(__dirname, "../../prisma/seed-giocatori.js");
  let out = "";
  let err = "";

  const proc = spawn(process.execPath, [seedPath], {
    env: process.env,
    cwd: path.join(__dirname, "../.."),
  });

  proc.stdout.on("data", (d) => { out += d.toString(); });
  proc.stderr.on("data", (d) => { err += d.toString(); });

  const timer = setTimeout(() => {
    proc.kill();
    res.json({ ok: false, output: "⏱ Timeout: il processo ha impiegato troppo tempo." });
  }, 90000);

  proc.on("close", (code) => {
    clearTimeout(timer);
    const full = out + (err ? "\n\nSTDERR:\n" + err : "");
    res.json({ ok: code === 0, output: full.trim() });
  });
}

// Giocatori attivi appartenenti all'ultimo scraping
// (active=true AND con almeno una Quotazione nel giorno solare dell'ultima Quotazione globale)
async function findGiocatoriUltimoScraping() {
  const latestQuote = await prisma.quotazione.findFirst({
    orderBy: { createdAt: "desc" },
    select:  { createdAt: true },
  });
  const minDate = latestQuote
    ? new Date(new Date(latestQuote.createdAt).setHours(0, 0, 0, 0))
    : null;

  return prisma.giocatore.findMany({
    where: {
      active: true,
      ...(minDate && { quotazioni: { some: { createdAt: { gte: minDate } } } }),
    },
    orderBy: { nome: "asc" },
    select:  { id: true, nome: true, ruolo: true, squadra: true, valore: true },
  });
}

// ── GET /admin/contratti/nuovo ────────────────────────────────────────────────
async function showNuovoContratto(req, res) {
  const [giocatori, presidenti, contrattiAttivi, ultimeQuotazioniTM] = await Promise.all([
    findGiocatoriUltimoScraping(),
    prisma.user.findMany({
      where:   { isActive: true },
      orderBy: { email: "asc" },
      select:  { id: true, email: true, nickname: true, fantaTeam: { select: { nome: true } } },
    }),
    prisma.contratto.findMany({
      where:   { valido: true, tipo: "Acquisto" },
      orderBy: { createdAt: "desc" },
      select: {
        giocatoreId:     true,
        valoreGiocatore: true,
        fantaTeam: {
          select: {
            nome: true,
            user: { select: { nickname: true, email: true } },
          },
        },
      },
    }),
    prisma.quotazione.findMany({
      where:    { fonte: "transfermarkt" },
      orderBy:  { createdAt: "desc" },
      distinct: ["giocatoreId"],
      select:   { giocatoreId: true, valore: true },
    }),
  ]);

  // Per ogni giocatore: titolare + valore del suo contratto valido più recente
  const titolareMap = {};
  const valoreContrattoMap = {};
  contrattiAttivi.forEach(c => {
    if (c.giocatoreId in titolareMap) return; // ordinato desc: salta i meno recenti
    const presidente = c.fantaTeam?.user;
    titolareMap[c.giocatoreId] = presidente?.nickname || presidente?.email || c.fantaTeam?.nome || "N.A.";
    valoreContrattoMap[c.giocatoreId] = c.valoreGiocatore !== null ? Number(c.valoreGiocatore) : null;
  });

  // Ultima quotazione Transfermarkt per giocatore
  const valoreTMMap = {};
  ultimeQuotazioniTM.forEach(q => {
    if (q.valore !== null && q.valore !== undefined) {
      valoreTMMap[q.giocatoreId] = Number(q.valore);
    }
  });

  const giocatoriAnnotati = giocatori.map(g => ({
    ...g,
    hasContratto:      g.id in titolareMap,
    titolareContratto: titolareMap[g.id] || null,
    valoreContratto:   valoreContrattoMap[g.id] ?? null,
    valoreTM:          valoreTMMap[g.id] ?? (g.valore !== null && g.valore !== undefined ? Number(g.valore) : null),
  }));

  res.render("admin/nuovo-contratto", {
    giocatori: giocatoriAnnotati,
    presidenti,
    currentUser: req.user,
    error: null,
    parametri: await parametriService.getAll(),
  });
}

// ── POST /admin/contratti/nuovo ───────────────────────────────────────────────
async function saveNuovoContratto(req, res) {
  const {
    tipo, clausola, dataStipula, durataContratto,
    dataFine, giocatoreId, fantaPresidenteId,
    importoOperazione, prezzoAcquisto, provenienza, destinazione,
    sessione,
  } = req.body;

  // Validazione base
  const errors = [];
  if (!tipo)               errors.push("Tipo obbligatorio.");
  if (!dataStipula)        errors.push("Data stipula obbligatoria.");
  if (!durataContratto)    errors.push("Durata obbligatoria.");
  if (!giocatoreId)        errors.push("Giocatore obbligatorio.");
  if (!fantaPresidenteId)  errors.push("Fantapresidente obbligatorio.");

  // Coerenza sessione ↔ mese di stipula: Invernale=01-YYYY, Estiva=07-YYYY.
  // Non si applica al Prestito (campo Sessione non esposto in UI).
  if (tipo !== "Prestito" && dataStipula && /^\d{2}-\d{4}$/.test(dataStipula)) {
    const meseStipula = dataStipula.slice(0, 2);
    const meseAtteso  = sessione === "Invernale" ? "01" : "07";
    if (meseStipula !== meseAtteso) {
      errors.push(`Sessione ${sessione || "Estiva"}: data stipula deve essere ${meseAtteso}-YYYY (ricevuto ${dataStipula}).`);
    }
  }

  const durata = parseInt(durataContratto, 10);
  const params = await parametriService.getAll();
  const durataMin = params.contratto_durata_min || 1;
  const durataMax = params.contratto_durata_max || 3;
  if (durata < durataMin || durata > durataMax) errors.push(`Durata deve essere tra ${durataMin} e ${durataMax}.`);

  // Validazione corrispettivo prestito
  if (tipo === "Prestito") {
    const imp = parseFloat(importoOperazione);
    if (!importoOperazione || isNaN(imp)) {
      errors.push("Il corrispettivo del prestito è obbligatorio.");
    } else if (imp < 0.1 || imp > 5) {
      errors.push("Il corrispettivo del prestito deve essere tra 0.1 e 5 M.");
    }
    if (durata !== 1) {
      errors.push("Il prestito non può durare più di una stagione (durata = 1).");
    }
    // Sul prestito sono ammesse solo Diritto/Obbligo di riscatto.
    const clausoleAmmessePrestito = ["", "DirittoRiscatto", "ObbligoRiscatto"];
    if (clausola && !clausoleAmmessePrestito.includes(clausola)) {
      errors.push("Sul prestito sono ammesse solo le clausole Diritto di riscatto e Obbligo di riscatto.");
    }
  }

  // Validazione prezzo acquisto
  if (tipo === "Acquisto") {
    const prezzo = parseFloat(prezzoAcquisto);
    if (!prezzoAcquisto || isNaN(prezzo) || prezzo <= 0) {
      errors.push("Il prezzo di acquisto è obbligatorio e deve essere positivo.");
    }
  }

  // Validazione finestre di mercato per Acquisto
  if (tipo === "Acquisto" && dataStipula && /^\d{2}-\d{4}$/.test(dataStipula.trim())) {
    const meseStip = parseInt(dataStipula.trim().split("-")[0], 10);

    // Helper: parse GG-MM → mese
    const parseMese = (ggmm) => parseInt((ggmm || "").split("-")[1], 10);

    if (provenienza === "Pubblico") {
      // Pubblico: estiva (lug–set) OR invernale (gen–feb)
      const estIz = parseMese(params.mercato_estivo_inizio || "01-07");
      const estFin = parseMese(params.mercato_estivo_fine || "15-09");
      const invIz = parseMese(params.mercato_invernale_inizio || "01-01");
      const invFin = parseMese(params.mercato_invernale_fine || "15-02");
      const inEstiva = meseStip >= estIz && meseStip <= estFin;
      const inInvernale = meseStip >= invIz && meseStip <= invFin;
      if (!inEstiva && !inInvernale) {
        errors.push(`Mercato pubblico: acquisti consentiti solo nei mesi ${estIz}–${estFin} (estiva) o ${invIz}–${invFin} (invernale).`);
      }
    } else if (provenienza === "Privato") {
      // Privato: da luglio a febbraio (attraversa il capodanno)
      const privIz = parseMese(params.mercato_privato_inizio || "01-07");
      const privFin = parseMese(params.mercato_privato_fine || "15-02");
      // Finestra che attraversa l'anno: valido se mese >= inizio OR mese <= fine
      const inFinestra = privIz > privFin
        ? (meseStip >= privIz || meseStip <= privFin)
        : (meseStip >= privIz && meseStip <= privFin);
      if (!inFinestra) {
        errors.push(`Acquisti tra presidenti: consentiti solo nei mesi ${privIz}–${privFin}.`);
      }
    }
  }

  if (errors.length > 0) {
    const [giocatori, presidenti] = await Promise.all([
      findGiocatoriUltimoScraping(),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true, email: true, nickname: true, fantaTeam: { select: { nome: true } } } }),
    ]);
    return res.render("admin/nuovo-contratto", {
      giocatori, presidenti, currentUser: req.user, error: errors.join(" "), parametri: params,
    });
  }

  // Valore "alla stipula": sempre l'ultima valutazione Transfermarkt.
  // Priorità: ultima Quotazione fonte='transfermarkt'; fallback su Giocatore.valore.
  const gid = parseInt(giocatoreId, 10);
  const [giocatore, ultimaQuotTM] = await Promise.all([
    prisma.giocatore.findUnique({
      where:  { id: gid },
      select: { valore: true },
    }),
    prisma.quotazione.findFirst({
      where:   { giocatoreId: gid, fonte: "transfermarkt" },
      orderBy: { createdAt: "desc" },
      select:  { valore: true },
    }),
  ]);
  const valoreEffettivo = ultimaQuotTM?.valore ?? giocatore?.valore ?? null;

  // Calcola stipendio server-side per Acquisto (non fidarsi del client).
  // Percentuale guidata dalla sessione scelta dall'utente: Estiva=10%, Invernale=5%.
  let importo = importoOperazione ? parseFloat(importoOperazione) : null;
  if (tipo === "Acquisto" && valoreEffettivo) {
    const isInvernale = sessione === "Invernale";
    const pct = isInvernale
      ? parseFloat(params.stipendio_percentuale_invernale || "0.05")
      : parseFloat(params.stipendio_percentuale || "0.10");
    importo = Math.round(parseFloat(valoreEffettivo) * pct * 100) / 100;

    // Validazione prezzoAcquisto: ±40% dell'ultima quotazione TM, max 1 decimale
    const prezzoRaw = prezzoAcquisto !== undefined && prezzoAcquisto !== null ? String(prezzoAcquisto).trim() : "";
    if (prezzoRaw === "") {
      errors.push("Prezzo acquisto obbligatorio.");
    } else if (!/^\d+(\.\d)?$/.test(prezzoRaw)) {
      errors.push(`Prezzo acquisto: ammessa al massimo 1 cifra decimale (ricevuto ${prezzoRaw}).`);
    } else {
      const prezzo = parseFloat(prezzoRaw);
      const baseV  = parseFloat(valoreEffettivo);
      const minP   = Math.round(baseV * 0.6 * 10) / 10;
      const maxP   = Math.round(baseV * 1.4 * 10) / 10;
      if (prezzo < minP || prezzo > maxP) {
        errors.push(`Prezzo acquisto fuori range: ammesso ${minP.toFixed(1)} – ${maxP.toFixed(1)} M (±40% di ${baseV.toFixed(2)} M, ricevuto ${prezzo.toFixed(2)}).`);
      }
    }
  }

  // Validazione post-calcolo (prezzoAcquisto/stipendio): rirenderizza form se errori
  if (errors.length > 0) {
    const [giocatoriR, presidentiR] = await Promise.all([
      findGiocatoriUltimoScraping(),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true, email: true, nickname: true, fantaTeam: { select: { nome: true } } } }),
    ]);
    return res.render("admin/nuovo-contratto", {
      giocatori: giocatoriR, presidenti: presidentiR, currentUser: req.user, error: errors.join(" "), parametri: params,
    });
  }

  // Ricalcola data fine server-side (non fidarsi solo del client)
  // Stagione parametrizzata: inizio GG-MM, fine GG-MM
  const stagioneInizio = params.stagione_inizio || "01-07"; // GG-MM
  const meseInizioStagione = parseInt(stagioneInizio.split("-")[1], 10) || 7;

  function calcDataFineServer(stipula, durata, prov, tipoContratto) {
    if (!stipula || !/^\d{2}-\d{4}$/.test(stipula)) return null;
    const [mm, yyyy] = stipula.split("-").map(Number);
    if (!mm || !yyyy) return null;

    // Prestito: scade a fine stagione corrente
    if (tipoContratto === "Prestito") {
      return mm >= meseInizioStagione
        ? String(meseInizioStagione).padStart(2, "0") + "-" + (yyyy + 1)
        : String(meseInizioStagione).padStart(2, "0") + "-" + yyyy;
    }

    if (prov === "Pubblico") {
      const fineAnno = (mm === meseInizioStagione) ? yyyy + durata : yyyy + durata - 1;
      return String(meseInizioStagione).padStart(2, "0") + "-" + fineAnno;
    }
    return String(mm).padStart(2, "0") + "-" + (yyyy + durata);
  }
  const dataFineCalcolata = calcDataFineServer(dataStipula.trim(), durata, provenienza || null, tipo);

  // Trova il fantaTeam associato al presidente selezionato (acquirente B)
  const fantaTeam = await prisma.fantaTeam.findFirst({
    where:   { userId: parseInt(fantaPresidenteId, 10) },
    include: { user: true },
  });
  if (!fantaTeam) {
    const [giocatoriList, presidentiList] = await Promise.all([
      findGiocatoriUltimoScraping(),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true, email: true, nickname: true, fantaTeam: { select: { nome: true } } } }),
    ]);
    return res.render("admin/nuovo-contratto", {
      giocatori: giocatoriList, presidenti: presidentiList, currentUser: req.user,
      error: "Il presidente selezionato non ha un FantaTeam associato.", parametri: params,
    });
  }

  // destinazione = nickname (o email) dell'acquirente, derivato server-side.
  // Il form lato admin non espone il campo per Acquisto/Prestito → riempito qui
  // così la colonna non resta NULL e resta consistente con i contratti storici.
  const destinazioneAuto = fantaTeam.user
    ? (fantaTeam.user.nickname || fantaTeam.user.email)
    : null;
  if (!destinazioneAuto) {
    const [giocatoriList2, presidentiList2] = await Promise.all([
      findGiocatoriUltimoScraping(),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true, email: true, nickname: true, fantaTeam: { select: { nome: true } } } }),
    ]);
    return res.render("admin/nuovo-contratto", {
      giocatori: giocatoriList2, presidenti: presidentiList2, currentUser: req.user,
      error: "Impossibile determinare la destinazione: il FantaTeam selezionato non ha un user collegato.",
      parametri: params,
    });
  }

  const prezzoNum     = tipo === "Acquisto" ? parseFloat(prezzoAcquisto) : null;
  const stipendioBNum = tipo === "Acquisto" && Number.isFinite(importo) ? importo : null;
  const isPrivato     = tipo === "Acquisto" && provenienza && provenienza !== "Pubblico";
  const importoPrestitoNum = tipo === "Prestito" && Number.isFinite(parseFloat(importoOperazione))
    ? parseFloat(importoOperazione)
    : null;

  // Identifica il contratto del venditore A (ultimo Acquisto valido).
  //  - Acquisto privato: serve per addebito/accredito + invalidazione.
  //  - Prestito: serve per identificare il presidente di provenienza (accredito);
  //    NON viene invalidato.
  let contrattoVenditore = null;
  if (isPrivato || tipo === "Prestito") {
    contrattoVenditore = await prisma.contratto.findFirst({
      where: {
        giocatoreId: parseInt(giocatoreId, 10),
        tipo:        "Acquisto",
        valido:      true,
      },
      orderBy: { createdAt: "desc" },
      include: { fantaTeam: { include: { user: true } } },
    });
  }

  // ── Preflight Prestito ────────────────────────────────────────────────────
  // (a) deve esistere un contratto Acquisto valido (prestito solo su giocatori con contratto)
  // (b) il giocatore non deve essere già oggetto di un altro Prestito valido
  // (c) spesa totale prestiti in essere del buyer + corrispettivo nuovo ≤ prestiti_spesa_max_totale
  if (tipo === "Prestito") {
    if (!contrattoVenditore) {
      errors.push("Il prestito può essere stipulato solo su giocatori con un contratto di Acquisto attivo.");
    }
    const prestitoEsistente = await prisma.contratto.findFirst({
      where:   { giocatoreId: parseInt(giocatoreId, 10), tipo: "Prestito", valido: true },
      include: { fantaTeam: { select: { nome: true } } },
    });
    if (prestitoEsistente) {
      const nomeTeam = prestitoEsistente.fantaTeam?.nome || "(team sconosciuto)";
      errors.push(
        `Il giocatore è già in prestito presso ${nomeTeam} (contratto #${prestitoEsistente.id}). ` +
        `Non è possibile stipulare un secondo prestito finché il precedente è valido.`
      );
    }
    if (importoPrestitoNum === null || importoPrestitoNum <= 0) {
      errors.push("Corrispettivo del prestito mancante o non valido.");
    } else {
      const prestitiBuyerAttivi = await prisma.contratto.findMany({
        where:  { fantaTeamId: fantaTeam.id, tipo: "Prestito", valido: true },
        select: { importoOperazione: true },
      });
      const totaleGiaImpegnato = prestitiBuyerAttivi.reduce(
        (s, c) => s + (c.importoOperazione ? Number(c.importoOperazione) : 0), 0
      );
      const maxSpesaPrestiti = parseFloat(params.prestiti_spesa_max_totale || "5");
      const nuovoTotale = Math.round((totaleGiaImpegnato + importoPrestitoNum) * 100) / 100;
      if (nuovoTotale > maxSpesaPrestiti + 1e-9) {
        errors.push(
          `Spesa massima prestiti superata: già impegnati ${totaleGiaImpegnato.toFixed(2)} M ` +
          `su ${maxSpesaPrestiti.toFixed(2)} M massimi; questo prestito porterebbe il totale a ${nuovoTotale.toFixed(2)} M.`
        );
      }
    }
  }

  // ── Calcolo storno stipendio (rimborso a A) ────────────────────────────────
  // Matrice: A-Estiva→B-Estiva 100%, A-Estiva→B-Invernale 50%, A-Inv→B-Inv 100%, altri 0.
  function sessioneDaMese(mm) {
    if (mm === 1)  return "Invernale";
    if (mm === 7)  return "Estiva";
    return null;
  }
  let stornoStipendio = 0;
  let sessioneA       = null;
  if (contrattoVenditore) {
    const mmA = parseInt((contrattoVenditore.dataStipula || "").slice(0, 2), 10);
    sessioneA = sessioneDaMese(mmA);
    const stipendioA = contrattoVenditore.importoOperazione
      ? Number(contrattoVenditore.importoOperazione) : 0;
    const sessioneB = sessione;
    let pct = 0;
    if (sessioneA === "Estiva"    && sessioneB === "Estiva")     pct = 1.00;
    else if (sessioneA === "Estiva"    && sessioneB === "Invernale")  pct = 0.50;
    else if (sessioneA === "Invernale" && sessioneB === "Invernale")  pct = 1.00;
    stornoStipendio = Math.round(stipendioA * pct * 100) / 100;
  }

  // Determina la stagione corrente dalla data stipula
  const meseInizioStagione2 = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const [mmStip, yyyyStip]  = dataStipula.trim().split("-").map(Number);
  const annoStagioneInizio  = mmStip >= meseInizioStagione2 ? yyyyStip : yyyyStip - 1;
  const stagione            = `${annoStagioneInizio}-${annoStagioneInizio + 1}`;

  // ── Preflight SF: blocca la stipula se mancano le SF della stagione ────────
  // Senza queste righe il contratto verrebbe creato, ma i saldi non verrebbero
  // toccati e il log UPDATE situazione_finanziaria non verrebbe emesso →
  // impossibile fare rollback successivo (annullaContratto fallirebbe).
  let sfBuyerPreflight = null;
  let sfSellerPreflight = null;
  if (tipo === "Acquisto" || tipo === "Prestito") {
    const buyerUser = await prisma.user.findUnique({
      where: { id: parseInt(fantaPresidenteId, 10) },
    });
    if (!buyerUser) {
      errors.push("Presidente acquirente non trovato.");
    } else {
      sfBuyerPreflight = await prisma.situazioneFinanziaria.findFirst({
        where: { nomePresidente: buyerUser.nickname || buyerUser.email, stagione },
      });
      if (!sfBuyerPreflight) {
        errors.push(
          `Situazione finanziaria mancante per '${buyerUser.nickname || buyerUser.email}' stagione ${stagione}. ` +
          `Crea la SF della stagione prima di stipulare il contratto.`
        );
      }
    }
    const needsSellerSF = (isPrivato || tipo === "Prestito")
                          && contrattoVenditore && contrattoVenditore.fantaTeam?.user;
    if (needsSellerSF) {
      const sellerUser = contrattoVenditore.fantaTeam.user;
      sfSellerPreflight = await prisma.situazioneFinanziaria.findFirst({
        where: { nomePresidente: sellerUser.nickname || sellerUser.email, stagione },
      });
      if (!sfSellerPreflight) {
        errors.push(
          `Situazione finanziaria mancante per il ${tipo === "Prestito" ? "presidente di provenienza" : "venditore"} ` +
          `'${sellerUser.nickname || sellerUser.email}' stagione ${stagione}. ` +
          `Stipula impossibile finché la SF non viene creata.`
        );
      }
    }
  }

  if (errors.length > 0) {
    const [giocatoriR2, presidentiR2] = await Promise.all([
      findGiocatoriUltimoScraping(),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true, email: true, nickname: true, fantaTeam: { select: { nome: true } } } }),
    ]);
    return res.render("admin/nuovo-contratto", {
      giocatori: giocatoriR2, presidenti: presidentiR2, currentUser: req.user, error: errors.join(" "), parametri: params,
    });
  }

  // ── Transazione atomica: chiusura contratti precedenti + creazione nuovo +
  //    movimenti finanziari B (acquirente) e A (venditore privato).
  const nuovoContrattoPayload = await prisma.$transaction(async (tx) => {
    // 1. Chiudi contratti precedenti dello stesso giocatore
    //    Cattura prima gli id per consentire l'annullamento futuro.
    const whereInvalidate = tipo === "Prestito"
      ? { giocatoreId: parseInt(giocatoreId, 10), valido: true, tipo: "Prestito" }
      : { giocatoreId: parseInt(giocatoreId, 10), valido: true };
    const toInvalidate = await tx.contratto.findMany({
      where:  whereInvalidate,
      select: { id: true },
    });
    const contrattiInvalidatiIds = toInvalidate.map(c => c.id);
    if (contrattiInvalidatiIds.length > 0) {
      await tx.contratto.updateMany({
        where: { id: { in: contrattiInvalidatiIds } },
        data:  { valido: false },
      });
    }

    // 2. Crea il nuovo contratto
    const nuovo = await tx.contratto.create({
      data: {
        tipo,
        clausola:          clausola || null,
        dataStipula:       dataStipula.trim(),
        durataContratto:   durata,
        dataFine:          dataFineCalcolata,
        giocatoreId:       parseInt(giocatoreId, 10),
        fantaTeamId:       fantaTeam.id,
        valoreGiocatore:   valoreEffettivo,
        importoOperazione: Number.isFinite(importo) ? importo : null,
        prezzoAcquisto:    Number.isFinite(prezzoNum) ? prezzoNum : null,
        provenienza:       provenienza || null,
        destinazione:      destinazioneAuto,
      },
    });

    // 3. Movimenti finanziari (solo per Acquisto)
    let movimentoBuyer = null;
    let movimentoSeller = null;
    if (tipo === "Acquisto" && Number.isFinite(prezzoNum) && prezzoNum > 0) {
      // 3a. Acquirente B: addebito = prezzo + stipendio nuovo
      const buyerUser = await tx.user.findUnique({
        where: { id: parseInt(fantaPresidenteId, 10) },
      });
      if (!buyerUser) {
        throw new Error(`Presidente acquirente id=${fantaPresidenteId} non trovato in transazione.`);
      }
      {
        const sfBuyer = await tx.situazioneFinanziaria.findFirst({
          where: { nomePresidente: buyerUser.nickname || buyerUser.email, stagione },
        });
        if (!sfBuyer) {
          throw new Error(`SF acquirente '${buyerUser.nickname || buyerUser.email}' stagione ${stagione} non trovata in transazione.`);
        }
        {
          const addebito        = prezzoNum + (Number.isFinite(stipendioBNum) ? stipendioBNum : 0);
          const creditiPrima    = parseFloat(sfBuyer.crediti);
          const patrimonioPrima = parseFloat(sfBuyer.patrimonio);
          const stipendiPrima   = parseFloat(sfBuyer.stipendi);
          const nuoviCrediti    = Math.round((creditiPrima    - addebito) * 100) / 100;
          const nuovoPatrimonio = Math.round((patrimonioPrima - addebito) * 100) / 100;
          const nuoviStipendi   = Math.round((stipendiPrima   + (stipendioBNum || 0)) * 100) / 100;
          await tx.situazioneFinanziaria.update({
            where: { id: sfBuyer.id },
            data:  { crediti: nuoviCrediti, patrimonio: nuovoPatrimonio, stipendi: nuoviStipendi },
          });
          movimentoBuyer = {
            sfId:               sfBuyer.id,
            presidente:         sfBuyer.nomePresidente,
            ruolo:              "acquirente",
            prezzo:             prezzoNum,
            stipendio:          stipendioBNum,
            addebitoTotale:     addebito,
            crediti:    { prima: creditiPrima,    dopo: nuoviCrediti },
            patrimonio: { prima: patrimonioPrima, dopo: nuovoPatrimonio },
            stipendi:   { prima: stipendiPrima,   dopo: nuoviStipendi },
          };
        }
      }

      // 3b. Venditore A (solo privato): accredito = prezzo + storno stipendio
      if (isPrivato && contrattoVenditore && contrattoVenditore.fantaTeam?.user) {
        const sellerUser = contrattoVenditore.fantaTeam.user;
        const sfSeller   = await tx.situazioneFinanziaria.findFirst({
          where: { nomePresidente: sellerUser.nickname || sellerUser.email, stagione },
        });
        if (!sfSeller) {
          throw new Error(`SF venditore '${sellerUser.nickname || sellerUser.email}' stagione ${stagione} non trovata in transazione.`);
        }
        {
          const accredito       = prezzoNum + stornoStipendio;
          const creditiPrima    = parseFloat(sfSeller.crediti);
          const patrimonioPrima = parseFloat(sfSeller.patrimonio);
          const stipendiPrima   = parseFloat(sfSeller.stipendi);
          const nuoviCrediti    = Math.round((creditiPrima    + accredito) * 100) / 100;
          const nuovoPatrimonio = Math.round((patrimonioPrima + accredito) * 100) / 100;
          // Storno riduce la voce "stipendi" del venditore (rimborso ricevuto)
          const nuoviStipendi   = Math.round((stipendiPrima   - stornoStipendio) * 100) / 100;
          await tx.situazioneFinanziaria.update({
            where: { id: sfSeller.id },
            data:  { crediti: nuoviCrediti, patrimonio: nuovoPatrimonio, stipendi: nuoviStipendi },
          });
          movimentoSeller = {
            sfId:               sfSeller.id,
            presidente:         sfSeller.nomePresidente,
            ruolo:              "venditore",
            prezzo:             prezzoNum,
            stornoStipendio:    stornoStipendio,
            sessioneVenditore:  sessioneA,
            sessioneAcquirente: sessione || null,
            accreditoTotale:    accredito,
            crediti:    { prima: creditiPrima,    dopo: nuoviCrediti },
            patrimonio: { prima: patrimonioPrima, dopo: nuovoPatrimonio },
            stipendi:   { prima: stipendiPrima,   dopo: nuoviStipendi },
          };
        }
      }
    }

    // 4. Movimenti finanziari Prestito: corrispettivo (importoOperazione)
    //    sottratto al buyer e accreditato al presidente di provenienza.
    //    Stipendi NON toccati (il prestito non genera stipendio).
    if (tipo === "Prestito" && Number.isFinite(importoPrestitoNum) && importoPrestitoNum > 0
        && contrattoVenditore && contrattoVenditore.fantaTeam?.user) {
      const buyerUser = await tx.user.findUnique({
        where: { id: parseInt(fantaPresidenteId, 10) },
      });
      if (!buyerUser) {
        throw new Error(`Presidente acquirente id=${fantaPresidenteId} non trovato in transazione.`);
      }
      const sfBuyer = await tx.situazioneFinanziaria.findFirst({
        where: { nomePresidente: buyerUser.nickname || buyerUser.email, stagione },
      });
      if (!sfBuyer) {
        throw new Error(`SF acquirente prestito '${buyerUser.nickname || buyerUser.email}' stagione ${stagione} non trovata in transazione.`);
      }
      {
        const creditiPrima    = parseFloat(sfBuyer.crediti);
        const patrimonioPrima = parseFloat(sfBuyer.patrimonio);
        const stipendiPrima   = parseFloat(sfBuyer.stipendi);
        const nuoviCrediti    = Math.round((creditiPrima    - importoPrestitoNum) * 100) / 100;
        const nuovoPatrimonio = Math.round((patrimonioPrima - importoPrestitoNum) * 100) / 100;
        await tx.situazioneFinanziaria.update({
          where: { id: sfBuyer.id },
          data:  { crediti: nuoviCrediti, patrimonio: nuovoPatrimonio },
        });
        movimentoBuyer = {
          sfId:           sfBuyer.id,
          presidente:     sfBuyer.nomePresidente,
          ruolo:          "acquirente",
          tipoMovimento:  "prestito",
          corrispettivo:  importoPrestitoNum,
          addebitoTotale: importoPrestitoNum,
          crediti:    { prima: creditiPrima,    dopo: nuoviCrediti },
          patrimonio: { prima: patrimonioPrima, dopo: nuovoPatrimonio },
          stipendi:   { prima: stipendiPrima,   dopo: stipendiPrima },
        };
      }

      const sellerUser = contrattoVenditore.fantaTeam.user;
      const sfSeller   = await tx.situazioneFinanziaria.findFirst({
        where: { nomePresidente: sellerUser.nickname || sellerUser.email, stagione },
      });
      if (!sfSeller) {
        throw new Error(`SF provenienza prestito '${sellerUser.nickname || sellerUser.email}' stagione ${stagione} non trovata in transazione.`);
      }
      {
        const creditiPrima    = parseFloat(sfSeller.crediti);
        const patrimonioPrima = parseFloat(sfSeller.patrimonio);
        const stipendiPrima   = parseFloat(sfSeller.stipendi);
        const nuoviCrediti    = Math.round((creditiPrima    + importoPrestitoNum) * 100) / 100;
        const nuovoPatrimonio = Math.round((patrimonioPrima + importoPrestitoNum) * 100) / 100;
        await tx.situazioneFinanziaria.update({
          where: { id: sfSeller.id },
          data:  { crediti: nuoviCrediti, patrimonio: nuovoPatrimonio },
        });
        movimentoSeller = {
          sfId:            sfSeller.id,
          presidente:      sfSeller.nomePresidente,
          ruolo:           "venditore",
          tipoMovimento:   "prestito",
          corrispettivo:   importoPrestitoNum,
          accreditoTotale: importoPrestitoNum,
          crediti:    { prima: creditiPrima,    dopo: nuoviCrediti },
          patrimonio: { prima: patrimonioPrima, dopo: nuovoPatrimonio },
          stipendi:   { prima: stipendiPrima,   dopo: stipendiPrima },
        };
      }
    }

    return { nuovoContratto: nuovo, movimentoBuyer, movimentoSeller, contrattiInvalidatiIds };
  });

  const { nuovoContratto, movimentoBuyer, movimentoSeller, contrattiInvalidatiIds } = nuovoContrattoPayload;
  await logAction({ azione: "CREATE", entita: "contratto", entitaId: nuovoContratto.id,
    dettaglio: {
      prima: null,
      dopo: {
        tipo,
        giocatoreId:       parseInt(giocatoreId, 10),
        fantaTeamId:       fantaTeam.id,
        dataStipula:       dataStipula.trim(),
        durataContratto:   durata,
        dataFine:          nuovoContratto.dataFine,
        valoreGiocatore:   nuovoContratto.valoreGiocatore ? Number(nuovoContratto.valoreGiocatore) : null,
        importoOperazione: Number.isFinite(importo) ? importo : null,
        prezzoAcquisto:    Number.isFinite(prezzoNum) ? prezzoNum : null,
        provenienza:       provenienza || null,
        sessione:          sessione || null,
        sessioneVenditore: sessioneA,
        stornoStipendio:   stornoStipendio,
        contrattoVenditoreId: contrattoVenditore ? contrattoVenditore.id : null,
        contrattiInvalidatiIds: contrattiInvalidatiIds || [],
      },
    },
    adminId: req.user.id });

  // Log movimenti finanziari (uno per presidente coinvolto)
  if (movimentoBuyer) {
    await logAction({
      azione:    "UPDATE",
      entita:    "situazione_finanziaria",
      entitaId:  movimentoBuyer.sfId,
      dettaglio: {
        contrattoId: nuovoContratto.id,
        giocatoreId: parseInt(giocatoreId, 10),
        movimento:   movimentoBuyer,
      },
      adminId: req.user.id,
    });
  }
  if (movimentoSeller) {
    await logAction({
      azione:    "UPDATE",
      entita:    "situazione_finanziaria",
      entitaId:  movimentoSeller.sfId,
      dettaglio: {
        contrattoId: nuovoContratto.id,
        giocatoreId: parseInt(giocatoreId, 10),
        movimento:   movimentoSeller,
      },
      adminId: req.user.id,
    });
  }

  res.redirect("/admin/contratti/riepilogo?created=1");
}

// ── POST /admin/contratti/:id/edit ────────────────────────────────────────────
async function saveEditContratto(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect("/admin/contratti/riepilogo");

  const {
    tipo, clausola, dataStipula, durataContratto,
    dataFine, valoreGiocatore, importoOperazione, provenienza, destinazione,
  } = req.body;

  const errors = [];
  if (!tipo)          errors.push("Tipo obbligatorio.");
  if (!dataStipula)   errors.push("Data stipula obbligatoria.");
  if (!durataContratto) errors.push("Durata obbligatoria.");

  const durata = parseInt(durataContratto, 10);
  const params = await parametriService.getAll();
  const durataMin = params.contratto_durata_min || 1;
  const durataMax = params.contratto_durata_max || 3;
  if (durata < durataMin || durata > durataMax) errors.push(`Durata deve essere tra ${durataMin} e ${durataMax}.`);

  if (errors.length > 0) {
    return res.redirect(`/admin/contratti/riepilogo?edited=${id}&error=${encodeURIComponent(errors.join(" "))}`);
  }

  const valore  = valoreGiocatore  ? parseFloat(valoreGiocatore)  : null;
  const importo = importoOperazione ? parseFloat(importoOperazione) : null;

  // Leggi stato prima della modifica
  const contrattoPre = await prisma.contratto.findUnique({
    where: { id },
    select: { tipo: true, clausola: true, dataStipula: true, durataContratto: true,
              dataFine: true, valoreGiocatore: true, importoOperazione: true, provenienza: true, destinazione: true },
  });

  await prisma.contratto.update({
    where: { id },
    data: {
      tipo,
      clausola:          clausola || null,
      dataStipula:       dataStipula.trim(),
      durataContratto:   durata,
      dataFine:          dataFine ? dataFine.trim() : null,
      valoreGiocatore:   Number.isFinite(valore)  ? valore  : null,
      importoOperazione: Number.isFinite(importo) ? importo : null,
      provenienza:       provenienza || null,
      destinazione:      destinazione || null,
    },
  });
  await logAction({ azione: "UPDATE", entita: "contratto", entitaId: id,
    dettaglio: {
      prima: contrattoPre ? {
        tipo:              contrattoPre.tipo,
        clausola:          contrattoPre.clausola ?? null,
        dataStipula:       contrattoPre.dataStipula,
        durataContratto:   contrattoPre.durataContratto,
        dataFine:          contrattoPre.dataFine ?? null,
        valoreGiocatore:   contrattoPre.valoreGiocatore ? Number(contrattoPre.valoreGiocatore) : null,
        importoOperazione: contrattoPre.importoOperazione ? Number(contrattoPre.importoOperazione) : null,
        provenienza:       contrattoPre.provenienza ?? null,
        destinazione:      contrattoPre.destinazione ?? null,
      } : null,
      dopo: {
        tipo,
        clausola:          clausola || null,
        dataStipula:       dataStipula.trim(),
        durataContratto:   durata,
        dataFine:          dataFine ? dataFine.trim() : null,
        valoreGiocatore:   Number.isFinite(valore)  ? valore  : null,
        importoOperazione: Number.isFinite(importo) ? importo : null,
        provenienza:       provenienza || null,
        destinazione:      destinazione || null,
      },
    },
    adminId: req.user.id });

  res.redirect(`/admin/contratti/riepilogo?edited=${id}&saved=1`);
}

// ── POST /admin/contratti/:id/annulla ────────────────────────────────────────
// Rollback completo della stipula:
//  - rivalida i contratti che la stipula aveva chiuso (valido=false → true)
//  - ripristina saldi crediti/patrimonio/stipendi di acquirente e venditore
//  - elimina il contratto annullato
// Tutto atomico in $transaction. Dati di rollback letti dai log_azioni emessi
// da saveNuovoContratto.
async function annullaContratto(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.redirect("/admin/contratti/riepilogo?error=" + encodeURIComponent("Id non valido."));
  }

  try {
    const contratto = await prisma.contratto.findUnique({
      where:   { id },
      include: { giocatore: { select: { id: true, nome: true } } },
    });
    if (!contratto) {
      return res.redirect("/admin/contratti/riepilogo?error=" + encodeURIComponent("Contratto non trovato."));
    }

    // 1. Log CREATE → estrae elenco contratti precedentemente invalidati
    const logCreate = await prisma.log.findFirst({
      where:   { entita: "contratto", entitaId: id, azione: "CREATE" },
      orderBy: { createdAt: "desc" },
    });
    let creationDettaglio = null;
    if (logCreate?.dettaglio) {
      try { creationDettaglio = JSON.parse(logCreate.dettaglio); } catch { /* ignore */ }
    }
    const contrattiInvalidatiIds = Array.isArray(creationDettaglio?.dopo?.contrattiInvalidatiIds)
      ? creationDettaglio.dopo.contrattiInvalidatiIds
      : null; // null = campo non presente nel log → log incompleto

    // 2. Log UPDATE situazione_finanziaria associati a questo contrattoId
    const logSF = await prisma.log.findMany({
      where:   { entita: "situazione_finanziaria", azione: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    const sfMovements = [];
    for (const l of logSF) {
      if (!l.dettaglio) continue;
      try {
        const d = JSON.parse(l.dettaglio);
        if (d.contrattoId === id && d.movimento?.sfId) {
          sfMovements.push(d.movimento);
        }
      } catch { /* ignore */ }
    }

    // ── 3. PRE-FLIGHT: verifica presenza dati di rollback ──────────────────
    // Acquisto richiede:
    //  - logCreate con contrattiInvalidatiIds (anche array vuoto è OK).
    //  - 1 movimento SF "acquirente" con snapshot prima completo.
    //  - Se provenienza ≠ "Pubblico" → anche 1 movimento "venditore".
    // Prestito: niente SF, niente preflight finanze (saveNuovoContratto non tocca finanze per Prestito).
    const missing = [];
    if (contratto.tipo === "Acquisto") {
      if (!logCreate)            missing.push("log CREATE assente");
      if (contrattiInvalidatiIds === null) {
        missing.push("log CREATE non contiene 'contrattiInvalidatiIds' (contratto stipulato prima dell'introduzione del rollback)");
      }

      const isPrivato = contratto.provenienza && contratto.provenienza !== "Pubblico";

      function snapshotValido(m, ruolo) {
        if (!m || m.ruolo !== ruolo) return false;
        for (const k of ["crediti", "patrimonio", "stipendi"]) {
          if (!m[k] || typeof m[k].prima !== "number") return false;
        }
        return true;
      }
      const movB = sfMovements.find(m => m.ruolo === "acquirente");
      const movA = sfMovements.find(m => m.ruolo === "venditore");

      if (!movB)                          missing.push("movimento SF acquirente assente");
      else if (!snapshotValido(movB, "acquirente")) missing.push("snapshot SF acquirente incompleto (crediti/patrimonio/stipendi 'prima' mancanti)");
      if (isPrivato) {
        if (!movA)                          missing.push("movimento SF venditore assente (provenienza='" + contratto.provenienza + "')");
        else if (!snapshotValido(movA, "venditore"))  missing.push("snapshot SF venditore incompleto");
      }
    }

    if (missing.length > 0) {
      const msg = "Annullamento non sicuro — dati di rollback incompleti: " + missing.join("; ") +
                  ". Modifica/elimina manualmente.";
      return res.redirect("/admin/contratti/riepilogo?error=" + encodeURIComponent(msg));
    }

    // contrattiInvalidatiIds ora è array (può essere vuoto)
    const idsToRevalidate = contrattiInvalidatiIds || [];

    // 4. Esecuzione atomica del rollback
    await prisma.$transaction(async (tx) => {
      // Ripristina saldi (prima → valore pre-stipula)
      for (const m of sfMovements) {
        await tx.situazioneFinanziaria.update({
          where: { id: m.sfId },
          data: {
            crediti:    m.crediti?.prima    ?? undefined,
            patrimonio: m.patrimonio?.prima ?? undefined,
            stipendi:   m.stipendi?.prima   ?? undefined,
          },
        });
      }
      // Rivalida contratti chiusi dalla stipula
      if (idsToRevalidate.length > 0) {
        await tx.contratto.updateMany({
          where: { id: { in: idsToRevalidate } },
          data:  { valido: true },
        });
      }
      // Elimina il contratto annullato (audit resta in log_azioni)
      await tx.contratto.delete({ where: { id } });
    });

    await logAction({
      azione:   "DELETE",
      entita:   "contratto",
      entitaId: id,
      dettaglio: {
        tipo:                "annullamento",
        giocatoreId:         contratto.giocatoreId,
        giocatoreNome:       contratto.giocatore?.nome,
        contrattiRivalidati: idsToRevalidate,
        movimentiAnnullati:  sfMovements.length,
        movimenti:           sfMovements,
      },
      adminId: req.user.id,
    });

    res.redirect("/admin/contratti/riepilogo?annullato=" + id);
  } catch (err) {
    res.redirect("/admin/contratti/riepilogo?error=" + encodeURIComponent("Annullamento fallito: " + err.message));
  }
}

// ── POST /admin/contratti/:id/delete ─────────────────────────────────────────
// ── GET /admin/log ────────────────────────────────────────────────────────────
async function listLog(req, res) {
  const PER_PAGINA = 50;
  const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
  const filtroAzione = req.query.azione || "";
  const filtroEntita = req.query.entita || "";
  const filtroAdmin  = req.query.adminId ? parseInt(req.query.adminId, 10) : null;

  const where = {};
  if (filtroAzione) where.azione  = filtroAzione;
  if (filtroEntita) where.entita  = filtroEntita;
  if (filtroAdmin)  where.adminId = filtroAdmin;

  const [totale, logs, admins] = await Promise.all([
    prisma.log.count({ where }),
    prisma.log.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip:  (pagina - 1) * PER_PAGINA,
      take:  PER_PAGINA,
      include: { admin: { select: { id: true, email: true, nickname: true } } },
    }),
    prisma.user.findMany({
      orderBy: { email: "asc" },
      select:  { id: true, email: true, nickname: true },
    }),
  ]);

  const totalePagine = Math.ceil(totale / PER_PAGINA);

  // Ricostruisce query string senza pagina per la paginazione
  const qp = new URLSearchParams();
  if (filtroAzione) qp.set("azione",   filtroAzione);
  if (filtroEntita) qp.set("entita",   filtroEntita);
  if (filtroAdmin)  qp.set("adminId",  filtroAdmin);

  res.render("admin/log", {
    logs,
    admins,
    totale,
    paginaCorrente: pagina,
    totalePagine,
    filtroAzione,
    filtroEntita,
    filtroAdmin,
    queryString: qp.toString(),
    currentUser: req.user,
  });
}

// ── GET /admin/parametri ─────────────────────────────────────────────────────
async function listParametri(req, res) {
  const parametri = await prisma.parametro.findMany({ orderBy: { chiave: "asc" } });
  const catalogo = await parametriService.getSerieACatalogo() || SERIE_A_TEAMS;
  const serieATeamNames = await parametriService.getSerieATeamNames();
  const allTeams = catalogo.map(t => t.nome);
  const activeTeams = serieATeamNames || allTeams;
  const message = req.query.saved ? "Parametro aggiornato."
                : req.query.teamsSaved ? "Squadre Serie A aggiornate."
                : req.query.teamAdded ? "Squadra aggiunta al catalogo."
                : req.query.teamRemoved ? "Squadra rimossa dal catalogo."
                : null;
  const error = req.query.error ? decodeURIComponent(req.query.error) : null;
  res.render("admin/parametri", { parametri, currentUser: req.user, message, error, allTeams, activeTeams, catalogo });
}

// ── POST /admin/parametri/serie-a-teams ──────────────────────────────────────
async function saveSerieATeams(req, res) {
  const teams = req.body.teams || [];
  const teamNames = Array.isArray(teams) ? teams : [teams];
  await parametriService.saveSerieATeamNames(teamNames);
  await logAction({ azione: "UPDATE", entita: "parametro", entitaId: null,
    dettaglio: { chiave: "serie_a_teams", squadre: teamNames }, adminId: req.user.id });
  res.redirect("/admin/parametri?teamsSaved=1");
}

// ── POST /admin/parametri/serie-a-catalogo/add ───────────────────────────────
async function addSerieATeam(req, res) {
  const nome = (req.body.nome || "").trim();
  const slug = (req.body.slug || "").trim();
  if (!nome || !slug) {
    return res.redirect("/admin/parametri?error=" + encodeURIComponent("Nome e slug sono obbligatori."));
  }
  const catalogo = await parametriService.getSerieACatalogo() || [...SERIE_A_TEAMS];
  if (catalogo.some(t => t.nome.toLowerCase() === nome.toLowerCase())) {
    return res.redirect("/admin/parametri?error=" + encodeURIComponent(`La squadra "${nome}" esiste già nel catalogo.`));
  }
  catalogo.push({ nome, slug });
  catalogo.sort((a, b) => a.nome.localeCompare(b.nome));
  await parametriService.saveSerieACatalogo(catalogo);
  await logAction({ azione: "CREATE", entita: "parametro", entitaId: null,
    dettaglio: { chiave: "serie_a_catalogo", aggiunta: { nome, slug } }, adminId: req.user.id });
  res.redirect("/admin/parametri?teamAdded=1");
}

// ── POST /admin/parametri/serie-a-catalogo/remove ────────────────────────────
async function removeSerieATeam(req, res) {
  const nome = (req.body.nome || "").trim();
  if (!nome) return res.redirect("/admin/parametri");
  const catalogo = await parametriService.getSerieACatalogo() || [...SERIE_A_TEAMS];
  const filtered = catalogo.filter(t => t.nome !== nome);
  await parametriService.saveSerieACatalogo(filtered);
  // Rimuovi anche dalla lista attiva se presente
  const activeNames = await parametriService.getSerieATeamNames();
  if (activeNames && activeNames.includes(nome)) {
    await parametriService.saveSerieATeamNames(activeNames.filter(n => n !== nome));
  }
  await logAction({ azione: "DELETE", entita: "parametro", entitaId: null,
    dettaglio: { chiave: "serie_a_catalogo", rimossa: nome }, adminId: req.user.id });
  res.redirect("/admin/parametri?teamRemoved=1");
}

// ── POST /admin/parametri/:id ────────────────────────────────────────────────
async function saveParametro(req, res) {
  const id = parseInt(req.params.id, 10);
  const { valore } = req.body;
  if (valore === undefined || valore === null) {
    return res.redirect("/admin/parametri");
  }
  await prisma.parametro.update({ where: { id }, data: { valore: valore.trim() } });
  parametriService.invalidateCache();
  await logAction({ azione: "UPDATE", entita: "parametro", entitaId: id,
    dettaglio: { valore: valore.trim() }, adminId: req.user.id });
  res.redirect("/admin/parametri?saved=1");
}

// ── GET /admin/rosa (redirect al primo team) ─────────────────────────────────
async function listRosa(req, res) {
  const params = await parametriService.getAll();
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const now = new Date();
  const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
  const stagione = `${annoInizio}-${annoInizio + 1}`;

  const fantaTeams = await prisma.fantaTeam.findMany({
    where: { OR: [{ userId: null }, { user: { isActive: true } }] },
    orderBy: { nome: "asc" },
    include: { user: { select: { nickname: true, email: true } } },
  });

  // Per ogni team, carica contratti validi e rosa
  const teamsData = await Promise.all(fantaTeams.map(async (ft) => {
    const contratti = await prisma.contratto.findMany({
      where: { fantaTeamId: ft.id, valido: true },
      include: { giocatore: true },
      orderBy: { giocatore: { nome: "asc" } },
    });
    const rosaRecords = await prisma.rosaGiocatore.findMany({
      where: { fantaTeamId: ft.id, stagione },
    });
    const rosaMap = {};
    rosaRecords.forEach((r) => { rosaMap[r.giocatoreId] = r.categoria; });

    const giocatori = contratti.map((c) => ({
      id: c.giocatore.id,
      nome: c.giocatore.nome,
      ruolo: c.giocatore.ruolo,
      squadra: c.giocatore.squadra,
      valore: c.giocatore.valore ? +c.giocatore.valore : null,
      categoria: rosaMap[c.giocatore.id] || "InRosa",
    }));

    return {
      id: ft.id,
      nome: ft.nome,
      presidente: ft.user ? (ft.user.nickname || ft.user.email) : null,
      giocatori,
      countInRosa: giocatori.filter(g => g.categoria === "InRosa").length,
      countFuoriRosa: giocatori.filter(g => g.categoria === "FuoriRosa").length,
      countU21: giocatori.filter(g => g.categoria === "U21").length,
    };
  }));

  res.render("admin/rose", {
    teamsData,
    stagione,
    params: {
      maxGiocatori: params.rosa_max_giocatori || 30,
      maxFuoriRosa: params.rosa_max_fuorirosa || 5,
      maxU21: params.rosa_max_under21 || 2,
    },
    currentUser: req.user,
  });
}

// ── GET /admin/rosa/:fantaTeamId ──────────────────────────────────────────────
async function showRosa(req, res) {
  const fantaTeamId = parseInt(req.params.fantaTeamId, 10);
  if (isNaN(fantaTeamId)) return res.redirect("/admin/pannello");

  const fantaTeam = await prisma.fantaTeam.findUnique({ where: { id: fantaTeamId } });
  if (!fantaTeam) return res.redirect("/admin/pannello");

  const params = await parametriService.getAll();
  // Determina stagione corrente
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const now = new Date();
  const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
  const stagione = `${annoInizio}-${annoInizio + 1}`;

  // Giocatori con contratto valido per questo team
  const contratti = await prisma.contratto.findMany({
    where: { fantaTeamId, valido: true },
    include: { giocatore: true },
    orderBy: { giocatore: { nome: "asc" } },
  });

  // Rosa assignments per questa stagione
  const rosaRecords = await prisma.rosaGiocatore.findMany({
    where: { fantaTeamId, stagione },
  });
  const rosaMap = {};
  rosaRecords.forEach((r) => { rosaMap[r.giocatoreId] = r.categoria; });

  // Componi lista
  const giocatori = contratti.map((c) => ({
    id: c.giocatore.id,
    nome: c.giocatore.nome,
    ruolo: c.giocatore.ruolo,
    squadra: c.giocatore.squadra,
    eta: c.giocatore.eta,
    valore: c.giocatore.valore ? +c.giocatore.valore : null,
    categoria: rosaMap[c.giocatore.id] || "InRosa",
  }));

  const fantaTeams = await prisma.fantaTeam.findMany({
    where: { OR: [{ userId: null }, { user: { isActive: true } }] },
    orderBy: { nome: "asc" },
  });

  res.render("admin/rosa", {
    fantaTeam,
    fantaTeams,
    giocatori,
    stagione,
    params: {
      maxGiocatori: params.rosa_max_giocatori || 30,
      maxFuoriRosa: params.rosa_max_fuorirosa || 5,
      maxU21: params.rosa_max_under21 || 2,
    },
    currentUser: req.user,
    message: req.query.saved === "1" ? "Rosa aggiornata." : null,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
  });
}

// ── POST /admin/rosa/:fantaTeamId ─────────────────────────────────────────────
async function saveRosa(req, res) {
  const fantaTeamId = parseInt(req.params.fantaTeamId, 10);
  if (isNaN(fantaTeamId)) return res.redirect("/admin/pannello");

  const params = await parametriService.getAll();
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const now = new Date();
  const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
  const stagione = `${annoInizio}-${annoInizio + 1}`;

  // Il form invia categorie[giocatoreId] = "InRosa" | "FuoriRosa" | "U21"
  const categorie = req.body.categorie || {};
  const validCategorie = ["InRosa", "FuoriRosa", "U21"];

  // Carica stato precedente per confronto
  const rosaPrec = await prisma.rosaGiocatore.findMany({
    where: { fantaTeamId, stagione },
  });
  const precMap = {};
  rosaPrec.forEach((r) => { precMap[r.giocatoreId] = r.categoria; });

  const movimenti = [];

  for (const [gId, cat] of Object.entries(categorie)) {
    const giocatoreId = parseInt(gId, 10);
    if (isNaN(giocatoreId) || !validCategorie.includes(cat)) continue;

    const catPrecedente = precMap[giocatoreId] || "InRosa";
    if (catPrecedente !== cat) {
      movimenti.push({ giocatoreId, da: catPrecedente, a: cat });
    }

    await prisma.rosaGiocatore.upsert({
      where: { fantaTeamId_giocatoreId_stagione: { fantaTeamId, giocatoreId, stagione } },
      update: { categoria: cat },
      create: { fantaTeamId, giocatoreId, stagione, categoria: cat },
    });
  }

  // Log solo se ci sono movimenti effettivi
  if (movimenti.length > 0) {
    // Recupera nomi giocatori per il dettaglio
    const giocatoriIds = movimenti.map((m) => m.giocatoreId);
    const giocatori = await prisma.giocatore.findMany({
      where: { id: { in: giocatoriIds } },
      select: { id: true, nome: true },
    });
    const nomiMap = {};
    giocatori.forEach((g) => { nomiMap[g.id] = g.nome; });

    const dettaglioMovimenti = movimenti.map((m) => ({
      giocatore: nomiMap[m.giocatoreId] || `#${m.giocatoreId}`,
      da: m.da,
      a: m.a,
    }));

    await logAction({
      azione: "UPDATE",
      entita: "rosa",
      entitaId: fantaTeamId,
      dettaglio: { stagione, movimenti: dettaglioMovimenti },
      adminId: req.user.id,
    });
  }

  res.redirect(`/admin/rosa/${fantaTeamId}?saved=1`);
}

// ── PREMI: inizio stagione + gennaio ──────────────────────────────────────────

const TIPI_PREMIO = {
  "inizio-stagione": { enum: "InizioStagione", label: "Premi inizio stagione", icona: "🏁" },
  "gennaio":         { enum: "Gennaio",        label: "Premi di gennaio",      icona: "❄️" },
};

function getStagioneCorrente(params) {
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const now = new Date();
  const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
  return `${annoInizio}-${annoInizio + 1}`;
}

// GET /admin/premi/:tipo
async function showPremi(req, res) {
  const tipoKey = req.params.tipo;
  const tipo = TIPI_PREMIO[tipoKey];
  if (!tipo) return res.status(404).send("Tipo premio non valido");

  const params = await parametriService.getAll();
  const stagione = getStagioneCorrente(params);

  const [presidenti, giaErogato] = await Promise.all([
    prisma.user.findMany({
      where:   { isActive: true, fantaTeam: { isNot: null } },
      orderBy: [{ nickname: "asc" }, { email: "asc" }],
      select:  { id: true, email: true, nickname: true, fantaTeam: { select: { id: true, nome: true } } },
    }),
    prisma.premioErogato.findFirst({
      where: { tipo: tipo.enum, stagione },
    }),
  ]);

  res.render("admin/premi", {
    tipoKey,
    tipo,
    stagione,
    presidenti,
    giaErogato,
    currentUser: req.user,
    error:   req.query.error   ? decodeURIComponent(req.query.error) : null,
    success: req.query.success === "1",
  });
}

// POST /admin/premi/:tipo
async function savePremi(req, res) {
  const tipoKey = req.params.tipo;
  const tipo = TIPI_PREMIO[tipoKey];
  if (!tipo) return res.status(404).send("Tipo premio non valido");

  const params = await parametriService.getAll();
  const stagione = getStagioneCorrente(params);

  // Blocco: già erogato per questo tipo + stagione?
  const giaErogato = await prisma.premioErogato.findFirst({
    where: { tipo: tipo.enum, stagione },
  });
  if (giaErogato) {
    return res.redirect(
      `/admin/premi/${tipoKey}?error=` +
      encodeURIComponent(`${tipo.label} già erogati per la stagione ${stagione} il ${new Date(giaErogato.createdAt).toLocaleString("it-IT")}.`)
    );
  }

  // Parse importi: req.body.importi è un object { [userId]: stringaImporto }
  const importiBody = req.body.importi || {};
  const erogazioni = [];
  let totale = 0;
  for (const [userIdStr, valStr] of Object.entries(importiBody)) {
    const userId = parseInt(userIdStr, 10);
    const val = parseFloat(valStr);
    if (!Number.isFinite(userId) || !Number.isFinite(val) || val <= 0) continue;
    const importo = Math.round(val * 100) / 100;
    erogazioni.push({ userId, importo });
    totale = Math.round((totale + importo) * 100) / 100;
  }

  if (erogazioni.length === 0) {
    return res.redirect(
      `/admin/premi/${tipoKey}?error=` +
      encodeURIComponent("Nessun importo valorizzato. Inserisci almeno un valore > 0.")
    );
  }

  // Pre-fetch presidenti con il loro fantaTeam (necessario per trovare la SituazioneFinanziaria)
  const userIds = erogazioni.map(e => e.userId);
  const utenti = await prisma.user.findMany({
    where:  { id: { in: userIds } },
    select: { id: true, nickname: true, email: true, fantaTeam: { select: { id: true, nome: true } } },
  });
  const userMap = new Map(utenti.map(u => [u.id, u]));

  // Verifica: tutti devono avere fantaTeam e SituazioneFinanziaria nella stagione corrente
  const fantaTeamIds = utenti.map(u => u.fantaTeam?.id).filter(Boolean);
  const sfList = await prisma.situazioneFinanziaria.findMany({
    where: { stagione, fantaTeamId: { in: fantaTeamIds } },
  });
  const sfByTeam = new Map(sfList.map(s => [s.fantaTeamId, s]));

  // Pre-check per messaggio d'errore prima di iniziare la transazione
  const mancanti = [];
  for (const e of erogazioni) {
    const u = userMap.get(e.userId);
    if (!u || !u.fantaTeam) {
      mancanti.push(`utente ${e.userId} senza fantaTeam`);
      continue;
    }
    if (!sfByTeam.has(u.fantaTeam.id)) {
      mancanti.push(`${u.nickname || u.email}: situazione finanziaria assente per ${stagione}`);
    }
  }
  if (mancanti.length > 0) {
    return res.redirect(
      `/admin/premi/${tipoKey}?error=` +
      encodeURIComponent(`Impossibile erogare: ${mancanti.join("; ")}`)
    );
  }

  // Transazione atomica: aggiorna SF di tutti i beneficiari + marca premio come erogato
  const movimenti = [];
  await prisma.$transaction(async (tx) => {
    for (const e of erogazioni) {
      const u = userMap.get(e.userId);
      const sf = sfByTeam.get(u.fantaTeam.id);
      const creditiPre   = parseFloat(sf.crediti);
      const patrimonioPre = parseFloat(sf.patrimonio);
      const creditiNuovi = Math.round((creditiPre + e.importo) * 100) / 100;
      const patrimonioNuovo = Math.round((patrimonioPre + e.importo) * 100) / 100;

      await tx.situazioneFinanziaria.update({
        where: { id: sf.id },
        data:  { crediti: creditiNuovi, patrimonio: patrimonioNuovo },
      });

      movimenti.push({
        userId:     e.userId,
        presidente: u.nickname || u.email,
        fantaTeam:  u.fantaTeam.nome,
        importo:    e.importo,
        prima:      { crediti: creditiPre,   patrimonio: patrimonioPre },
        dopo:       { crediti: creditiNuovi, patrimonio: patrimonioNuovo },
      });
    }

    await tx.premioErogato.create({
      data: {
        tipo:     tipo.enum,
        stagione,
        totale,
        numBenef: erogazioni.length,
        adminId:  req.user.id,
      },
    });
  });

  // Log fuori transazione
  await logAction({
    azione: "CREATE",
    entita: "premi_erogati",
    entitaId: null,
    dettaglio: {
      tipo:     tipo.enum,
      stagione,
      totale,
      numBenef: erogazioni.length,
      movimenti,
    },
    adminId: req.user.id,
  });

  res.redirect(`/admin/premi/${tipoKey}?success=1`);
}
