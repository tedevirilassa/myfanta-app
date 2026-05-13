// src/controllers/profile.controller.js
const prisma = require("../lib/prisma");
const { logAction } = require("../services/log.service");
const { cleanNickname } = require("../lib/sanitize");

// GET /profilo
function showProfile(req, res) {
  res.render("profile/index", {
    currentUser: req.user,
    success: null,
    error: null,
  });
}

// POST /profilo
async function saveProfile(req, res) {
  const { nickname, teamName } = req.body;

  // validazione base
  const nick = cleanNickname(nickname);
  const team = (teamName  || "").trim().slice(0, 60);

  try {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data:  { nickname: nick },
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

    // aggiorna req.user in-place così le view riflettono subito il cambiamento
    req.user.nickname = updated.nickname;
    req.user.fantaTeam = updated.fantaTeam;

    logAction({
      azione: "UPDATE",
      entita: "profilo",
      entitaId: req.user.id,
      dettaglio: { nickname: nick, teamName: team || null },
      adminId: req.user.id,
    });

    res.render("profile/index", {
      currentUser: req.user,
      success: "Profilo aggiornato con successo.",
      error: null,
    });
  } catch (err) {
    console.error("Profile save error:", err.message);
    res.render("profile/index", {
      currentUser: req.user,
      success: null,
      error: "Errore durante il salvataggio. Riprova.",
    });
  }
}

module.exports = { showProfile, saveProfile };
