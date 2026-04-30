// src/controllers/admin.controller.js
const prisma = require("../lib/prisma");
const authService = require("../services/auth.service");
const { logAction } = require("../services/log.service");
const parametriService = require("../services/parametri.service");
const { spawn } = require("child_process");
const path = require("path");

const DEFAULT_PASSWORD = "primalogin2026";

// GET /admin/users
async function listUsers(req, res) {
  const [users, tuttiTeam] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { fantaTeam: true } }),
    prisma.fantaTeam.findMany({ orderBy: { nome: "asc" } }),
  ]);
  const teamLiberi = tuttiTeam.filter((t) => t.userId === null);
  const reset = req.query.reset === "1";
  res.render("admin/users", {
    users,
    teamLiberi,
    tuttiTeam,
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

module.exports = { listUsers, toggleActive, resetPassword, showInvite, inviteUser, showEditProfile, saveEditProfile, showPannello, inlineEditUser, runSeedGiocatori, showNuovoContratto, saveNuovoContratto, listContrattiRiepilogo, saveEditContratto, deleteContratto, listLog, changeRole, createGiocatore, updateGiocatore, deleteGiocatore, assignFantaTeam, listSituazioneFinanziaria, assignFantaTeamToSituazione, saveUserFields, listParametri, saveParametro };

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
  const [situazioni, fantaTeams] = await Promise.all([
    prisma.situazioneFinanziaria.findMany({
      orderBy: [{ stagione: "desc" }, { nomePresidente: "asc" }],
      include: { fantaTeam: true },
    }),
    prisma.fantaTeam.findMany({ orderBy: { nome: "asc" } }),
  ]);

  const stagioni = [...new Set(situazioni.map((s) => s.stagione))].sort().reverse();

  res.render("admin/situazione-finanziaria", {
    situazioni,
    fantaTeams,
    stagioni,
    currentUser: req.user,
    message: req.query.saved   === "1" ? "Associazione salvata."       : null,
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
  const teams = await prisma.fantaTeam.findMany({
    orderBy: { nome: "asc" },
    include: {
      contratti: {
        orderBy: [{ giocatore: { ruolo: "asc" } }, { giocatore: { nome: "asc" } }],
        include: { giocatore: true },
      },
    },
  });

  const annoCorrente = new Date().getFullYear();
  let totaleContratti = 0;
  let scadenzaVicina = 0;
  let valoreTotal = 0;

  for (const team of teams) {
    totaleContratti += team.contratti.length;
    for (const c of team.contratti) {
      valoreTotal += parseFloat(c.valoreGiocatore || 0);
      if (c.dataFine) {
        const anno = parseInt(c.dataFine.split("-")[1]);
        if (anno <= annoCorrente) scadenzaVicina++;
      }
    }
  }

  res.render("admin/contratti-riepilogo", {
    teams,
    totaleContratti,
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
  const [giocatori, presidenti] = await Promise.all([
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
  ]);

  res.render("admin/nuovo-contratto", {
    giocatori,
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
    importoOperazione, provenienza, destinazione,
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

  const importo = importoOperazione ? parseFloat(importoOperazione) : null;

  // Ricalcola data fine server-side (non fidarsi solo del client)
  function calcDataFineServer(stipula, durata, prov) {
    if (!stipula || !/^\d{2}-\d{4}$/.test(stipula)) return null;
    const [mm, yyyy] = stipula.split("-").map(Number);
    if (!mm || !yyyy) return null;
    if (prov === "Pubblico") {
      const fineAnno = (mm === 7) ? yyyy + durata : yyyy + durata - 1;
      return "07-" + fineAnno;
    }
    return String(mm).padStart(2, "0") + "-" + (yyyy + durata);
  }
  const dataFineCalcolata = calcDataFineServer(dataStipula.trim(), durata, provenienza || null);

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
      provenienza:        provenienza || null,
      destinazione:       destinazione || null,
    },
  });
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
