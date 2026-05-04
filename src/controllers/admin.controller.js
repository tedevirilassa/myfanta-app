// src/controllers/admin.controller.js
const prisma = require("../lib/prisma");
const authService = require("../services/auth.service");
const { logAction } = require("../services/log.service");
const parametriService = require("../services/parametri.service");
const { syncQuotazioni: runSyncQuotazioni } = require("../services/sync-quotazioni.service");
const { scrapeSerieA, SERIE_A_TEAMS, scrapeSquadFromBrowser, createBrowser } = require("../services/transfermarkt.service");
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
  const teamLiberi = tuttiTeam.filter((t) => t.userId === null);
  const reset = req.query.reset === "1";
  res.render("admin/users", {
    users,
    teamLiberi,
    tuttiTeam,
    giocatoriIncompleti,
    currentUser: req.user,
    message: reset                  ? "Password reimpostata. L'utente dovrà cambiarla al prossimo accesso."
           : req.query.roleSaved    ? "Ruolo aggiornato con successo."
           : req.query.teamAssigned ? "FantaTeam assegnato con successo."
           : req.query.fieldSaved   ? "Dati utente aggiornati con successo."
           : null,
    roleError: req.query.roleError || null,
    error: req.query.teamError  ? decodeURIComponent(req.query.teamError)
         : req.query.fieldError ? decodeURIComponent(req.query.fieldError)
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
  const user = await prisma.user.findUnique({ where: { id } });
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
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.redirect("/admin/users");

  const nick = (req.body.nickname || "").trim().slice(0, 40);
  const team = (req.body.teamName  || "").trim().slice(0, 60);

  try {
    const updated = await prisma.user.update({
      where: { id },
      data: { nickname: nick || null, teamName: team || null },
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
    const stats = await runSyncQuotazioni(send, squadraFiltro);
    send({ type: "done", stats });
  } catch (err) {
    send({ type: "error", msg: err.message });
  } finally {
    res.end();
  }
}

// ── GET /admin/sync-transfermarkt ────────────────────────────────────────────
function showSyncTransfermarkt(req, res) {
  res.render("admin/sync-transfermarkt", { currentUser: req.user });
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
    // Filtra squadre se richiesto
    const teamsFiltrati = squadra
      ? SERIE_A_TEAMS.filter(t => t.nome === squadra)
      : SERIE_A_TEAMS;

    if (teamsFiltrati.length === 0) {
      send({ type: "error", msg: `Squadra "${squadra}" non trovata nella lista.` });
      return res.end();
    }

    send({ type: "log", msg: `🚀 Scraping ${teamsFiltrati.length} squadra/e…` });

    const browser = await createBrowser();

    // Raccoglie tutti i giocatori scrapati con il team associato
    const allScraped = [];
    const errori = [];

    const RETRY_MAX   = 3;
    const RETRY_DELAY = 10_000;

    for (const team of teamsFiltrati) {
      send({ type: "log", msg: `[TM] Scraping ${team.nome}…` });

      let players = null;
      let lastErr = null;

      for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
        try {
          players = await scrapeSquadFromBrowser(browser, team, (msg) => send({ type: "log", msg }));
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
          stats.inattivi++;
        }
        continue;
      }

      if (p.tipo === "update" && p.dbId) {
        await prisma.giocatore.update({
          where: { id: p.dbId },
          data: {
            squadra:         p.squadra,
            valore:          p.valore,
            active:          true,
            ...(p.ruolo          && { ruolo: p.ruolo }),
            ...(p.ruoloEsteso    && { ruoloEsteso: p.ruoloEsteso }),
            ...(p.dataNascita    && { dataNascita: p.dataNascita }),
            ...(p.nazionalita    && { nazionalita: p.nazionalita }),
            ...(p.transfermarktId && { transfermarktId: p.transfermarktId }),
          },
        });
        await prisma.quotazione.create({
          data: { giocatoreId: p.dbId, valore: p.valore, fonte: "transfermarkt", stagione: STAGIONE_CORRENTE },
        });
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
            nazionalita:     p.nazionalita   || null,
            transfermarktId: p.transfermarktId || null,
            active:          true,
          },
        });
        await prisma.quotazione.create({
          data: { giocatoreId: g.id, valore: p.valore, fonte: "transfermarkt", stagione: STAGIONE_CORRENTE },
        });
        stats.nuovi++;
        stats.quotazioni++;
      }
    } catch (err) {
      stats.errori++;
    }
  }

  res.json(stats);
}

module.exports = { listUsers, toggleActive, resetPassword, showInvite, inviteUser, showEditProfile, saveEditProfile, showPannello, inlineEditUser, runSeedGiocatori, showNuovoContratto, saveNuovoContratto, listContrattiRiepilogo, saveEditContratto, deleteContratto, listLog, changeRole, createGiocatore, updateGiocatore, deleteGiocatore, assignFantaTeam, listSituazioneFinanziaria, assignFantaTeamToSituazione, adjustCrediti, saveUserFields, listParametri, saveParametro, showRosa, saveRosa, syncQuotazioni, showSyncTransfermarkt, runScrapeTransfermarkt, importTransfermarkt };

// ── POST /admin/users/:id/save-fields ─────────────────────────────────────────────
async function saveUserFields(req, res) {
  const id = parseInt(req.params.id, 10);
  const email    = (req.body.email    || "").trim().toLowerCase();
  const nickname = (req.body.nickname || "").trim().slice(0, 40);
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
      data: { email, nickname: nickname || null },
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
      dopo:  { email, nickname: nickname || null, fantaTeamId },
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
    editSuccess: req.query.saved  === "1" ? "Contratto aggiornato con successo." :
                 req.query.deleted === "1" ? "Contratto eliminato."              : null,
    editError:   req.query.error  ? decodeURIComponent(req.query.error)          : null,
  });
}

// ── GET /admin/pannello ───────────────────────────────────────────────────────
async function showPannello(req, res) {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  res.render("admin/pannello", {
    users,
    currentUser: req.user,
    serieATeams: SERIE_A_TEAMS.map(t => t.nome),
    message: req.query.saved ? "Profilo aggiornato." : null,
    error: null,
  });
}

// ── POST /admin/users/:id/inline-profile ─────────────────────────────────────
async function inlineEditUser(req, res) {
  const id = parseInt(req.params.id, 10);
  const nick = (req.body.nickname || "").trim().slice(0, 40);
  const team = (req.body.teamName  || "").trim().slice(0, 60);
  try {
    const userPre = await prisma.user.findUnique({ where: { id }, select: { nickname: true } });
    await prisma.user.update({
      where: { id },
      data: { nickname: nick || null, teamName: team || null },
    });
    await logAction({ azione: "UPDATE", entita: "utente", entitaId: id,
      dettaglio: {
        prima: { nickname: userPre?.nickname ?? null },
        dopo:  { nickname: nick || null },
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

// ── GET /admin/contratti/nuovo ────────────────────────────────────────────────
async function showNuovoContratto(req, res) {
  const [giocatori, presidenti, contrattiAttivi] = await Promise.all([
    prisma.giocatore.findMany({
      where:   { active: true },
      orderBy: { nome: "asc" },
      select:  { id: true, nome: true, ruolo: true, squadra: true, valore: true },
    }),
    prisma.user.findMany({
      where:   { isActive: true },
      orderBy: { email: "asc" },
      select:  { id: true, email: true, nickname: true, teamName: true },
    }),
    prisma.contratto.findMany({
      where:  { valido: true },
      select: {
        giocatoreId: true,
        fantaTeam: {
          select: {
            nome: true,
            user: { select: { nickname: true, email: true } },
          },
        },
      },
    }),
  ]);

  // mappa giocatoreId → nome titolare (nickname o email del presidente)
  const titolareMap = {};
  contrattiAttivi.forEach(c => {
    const presidente = c.fantaTeam?.user;
    const nome = (presidente?.nickname || presidente?.email || c.fantaTeam?.nome || "N.A.");
    titolareMap[c.giocatoreId] = nome;
  });

  const giocatoriAnnotati = giocatori.map(g => ({
    ...g,
    hasContratto: g.id in titolareMap,
    titolareContratto: titolareMap[g.id] || null,
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
  } = req.body;

  // Validazione base
  const errors = [];
  if (!tipo)               errors.push("Tipo obbligatorio.");
  if (!dataStipula)        errors.push("Data stipula obbligatoria.");
  if (!durataContratto)    errors.push("Durata obbligatoria.");
  if (!giocatoreId)        errors.push("Giocatore obbligatorio.");
  if (!fantaPresidenteId)  errors.push("Fantapresidente obbligatorio.");

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
      prisma.giocatore.findMany({ where: { active: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true, ruolo: true, squadra: true, valore: true } }),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true, email: true, nickname: true, teamName: true } }),
    ]);
    return res.render("admin/nuovo-contratto", {
      giocatori, presidenti, currentUser: req.user, error: errors.join(" "), parametri: params,
    });
  }

  // Legge valore corrente dal giocatore
  const giocatore = await prisma.giocatore.findUnique({
    where:  { id: parseInt(giocatoreId, 10) },
    select: { valore: true },
  });

  // Calcola stipendio server-side per Acquisto (non fidarsi del client)
  let importo = importoOperazione ? parseFloat(importoOperazione) : null;
  if (tipo === "Acquisto" && giocatore && giocatore.valore) {
    const mercatoInvInizio = params.mercato_invernale_inizio || "01-01"; // GG-MM
    const mercatoInvFine = params.mercato_invernale_fine || "15-02";     // GG-MM
    const meseStipula = parseInt((dataStipula || "").split("-")[0], 10);
    const invIzMM = parseInt(mercatoInvInizio.split("-")[1], 10);
    const invFinMM = parseInt(mercatoInvFine.split("-")[1], 10);
    const isInvernale = meseStipula >= invIzMM && meseStipula <= invFinMM;
    const pct = isInvernale
      ? parseFloat(params.stipendio_percentuale_invernale || "0.05")
      : parseFloat(params.stipendio_percentuale || "0.10");
    importo = Math.round(parseFloat(giocatore.valore) * pct * 100) / 100;
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

  // Marca come scaduti i contratti precedenti dello stesso giocatore
  // - Acquisto/Cessione nuovo → invalida tutti i precedenti (Acquisto + Prestito)
  // - Prestito nuovo → invalida solo i Prestiti precedenti (l'Acquisto resta valido)
  if (tipo === "Prestito") {
    await prisma.contratto.updateMany({
      where: { giocatoreId: parseInt(giocatoreId, 10), valido: true, tipo: "Prestito" },
      data: { valido: false },
    });
  } else {
    await prisma.contratto.updateMany({
      where: { giocatoreId: parseInt(giocatoreId, 10), valido: true },
      data: { valido: false },
    });
  }

  // Trova il fantaTeam associato al presidente selezionato
  const fantaTeam = await prisma.fantaTeam.findFirst({
    where: { userId: parseInt(fantaPresidenteId, 10) },
  });
  if (!fantaTeam) {
    const [giocatoriList, presidentiList] = await Promise.all([
      prisma.giocatore.findMany({ where: { active: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true, ruolo: true, squadra: true, valore: true } }),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true, email: true, nickname: true, teamName: true } }),
    ]);
    return res.render("admin/nuovo-contratto", {
      giocatori: giocatoriList, presidenti: presidentiList, currentUser: req.user,
      error: "Il presidente selezionato non ha un FantaTeam associato.", parametri: params,
    });
  }

  const prezzoNum = tipo === "Acquisto" ? parseFloat(prezzoAcquisto) : null;

  const nuovoContratto = await prisma.contratto.create({
    data: {
      tipo,
      clausola:           clausola || null,
      dataStipula:        dataStipula.trim(),
      durataContratto:    durata,
      dataFine:           dataFineCalcolata,
      giocatoreId:        parseInt(giocatoreId, 10),
      fantaTeamId:        fantaTeam.id,
      valoreGiocatore:    giocatore?.valore ?? null,
      importoOperazione:  Number.isFinite(importo) ? importo : null,
      prezzoAcquisto:     Number.isFinite(prezzoNum) ? prezzoNum : null,
      provenienza:        provenienza || null,
      destinazione:       destinazione || null,
    },
  });

  // ── Aggiornamento crediti per Acquisto ──────────────────────────────────────
  if (tipo === "Acquisto" && Number.isFinite(prezzoNum) && prezzoNum > 0) {
    // Determina la stagione corrente dalla data stipula
    const meseInizioStagione2 = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
    const [mmStip, yyyyStip] = dataStipula.trim().split("-").map(Number);
    const annoStagioneInizio = mmStip >= meseInizioStagione2 ? yyyyStip : yyyyStip - 1;
    const stagione = `${annoStagioneInizio}-${annoStagioneInizio + 1}`;

    // Acquirente: crediti -= prezzo
    const buyerUser = await prisma.user.findUnique({ where: { id: parseInt(fantaPresidenteId, 10) } });
    if (buyerUser) {
      const sfBuyer = await prisma.situazioneFinanziaria.findFirst({
        where: { nomePresidente: buyerUser.nickname || buyerUser.email, stagione },
      });
      if (sfBuyer) {
        const nuoviCreditiBuyer = Math.round((parseFloat(sfBuyer.crediti) - prezzoNum) * 100) / 100;
        const nuovoPatrimonioBuyer = Math.round((parseFloat(sfBuyer.patrimonio) - prezzoNum) * 100) / 100;
        await prisma.situazioneFinanziaria.update({
          where: { id: sfBuyer.id },
          data: { crediti: nuoviCreditiBuyer, patrimonio: nuovoPatrimonioBuyer },
        });
      }
    }

    // Venditore (solo Privato): crediti += prezzo
    if (provenienza === "Privato") {
      // Il venditore è il presidente dell'ultimo contratto Acquisto valido per lo stesso giocatore (prima di invalidarlo)
      const contrattoVenditore = await prisma.contratto.findFirst({
        where: {
          giocatoreId: parseInt(giocatoreId, 10),
          tipo: "Acquisto",
          id: { not: nuovoContratto.id },
        },
        orderBy: { createdAt: "desc" },
        include: { fantaTeam: { include: { user: true } } },
      });
      if (contrattoVenditore && contrattoVenditore.fantaTeam?.user) {
        const sellerUser = contrattoVenditore.fantaTeam.user;
        const sfSeller = await prisma.situazioneFinanziaria.findFirst({
          where: { nomePresidente: sellerUser.nickname || sellerUser.email, stagione },
        });
        if (sfSeller) {
          const nuoviCreditiSeller = Math.round((parseFloat(sfSeller.crediti) + prezzoNum) * 100) / 100;
          const nuovoPatrimonioSeller = Math.round((parseFloat(sfSeller.patrimonio) + prezzoNum) * 100) / 100;
          await prisma.situazioneFinanziaria.update({
            where: { id: sfSeller.id },
            data: { crediti: nuoviCreditiSeller, patrimonio: nuovoPatrimonioSeller },
          });
        }
      }
    }
  }

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
      },
    },
    adminId: req.user.id });

  res.redirect("/admin/contratti?created=1");
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

// ── POST /admin/contratti/:id/delete ─────────────────────────────────────────
async function deleteContratto(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!isNaN(id)) {
    // Leggi prima i dati per il log
    const c = await prisma.contratto.findUnique({
      where: { id },
      include: { giocatore: { select: { nome: true, ruolo: true } }, fantaTeam: { select: { nome: true } } },
    });
    await prisma.contratto.delete({ where: { id } });
    await logAction({ azione: "DELETE", entita: "contratto", entitaId: id,
      dettaglio: {
        prima: c ? {
          giocatore:         c.giocatore?.nome,
          ruolo:             c.giocatore?.ruolo,
          team:              c.fantaTeam?.nome,
          tipo:              c.tipo,
          clausola:          c.clausola ?? null,
          dataStipula:       c.dataStipula,
          durataContratto:   c.durataContratto,
          dataFine:          c.dataFine ?? null,
          valoreGiocatore:   c.valoreGiocatore ? Number(c.valoreGiocatore) : null,
          importoOperazione: c.importoOperazione ? Number(c.importoOperazione) : null,
          provenienza:       c.provenienza ?? null,
        } : null,
        dopo: null,
      },
      adminId: req.user.id });
  }
  res.redirect("/admin/contratti/riepilogo?deleted=1");
}

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
  const message = req.query.saved ? "Parametro aggiornato." : null;
  res.render("admin/parametri", { parametri, currentUser: req.user, message });
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

  for (const [gId, cat] of Object.entries(categorie)) {
    const giocatoreId = parseInt(gId, 10);
    if (isNaN(giocatoreId) || !validCategorie.includes(cat)) continue;

    await prisma.rosaGiocatore.upsert({
      where: { fantaTeamId_giocatoreId_stagione: { fantaTeamId, giocatoreId, stagione } },
      update: { categoria: cat },
      create: { fantaTeamId, giocatoreId, stagione, categoria: cat },
    });
  }

  await logAction({
    azione: "UPDATE",
    entita: "rosa",
    entitaId: fantaTeamId,
    dettaglio: { stagione, categorie },
    adminId: req.user.id,
  });

  res.redirect(`/admin/rosa/${fantaTeamId}?saved=1`);
}
