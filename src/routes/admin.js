// src/routes/admin.js
const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/admin.controller");

// Tutte le rotte admin richiedono autenticazione + ruolo ADMIN
router.use(requireAuth, requireAdmin);

router.get("/users", ctrl.listUsers);
router.post("/users/:id/save-fields", ctrl.saveUserFields);
router.get("/pannello", ctrl.showPannello);
router.get("/contratti/riepilogo", ctrl.listContrattiRiepilogo);
router.get("/contratti/nuovo", ctrl.showNuovoContratto);
router.post("/contratti/nuovo", ctrl.saveNuovoContratto);
router.post("/contratti/:id/edit", ctrl.saveEditContratto);
router.post("/contratti/:id/delete", ctrl.deleteContratto);
router.get("/log", ctrl.listLog);
router.get("/users/invite", ctrl.showInvite);
router.post("/users/invite", ctrl.inviteUser);
router.get("/users/:id/edit-profile", ctrl.showEditProfile);
router.post("/users/:id/edit-profile", ctrl.saveEditProfile);
router.post("/users/:id/inline-profile", ctrl.inlineEditUser);
router.post("/users/:id/toggle", ctrl.toggleActive);
router.post("/users/:id/reset-password", ctrl.resetPassword);
router.post("/users/:id/change-role", ctrl.changeRole);
router.post("/giocatori", ctrl.createGiocatore);
router.post("/giocatori/:id", ctrl.updateGiocatore);
router.post("/giocatori/:id/delete", ctrl.deleteGiocatore);
router.post("/fanta-teams/:id/assign", ctrl.assignFantaTeam);
router.post("/tools/seed-giocatori", ctrl.runSeedGiocatori);
router.get("/situazione-finanziaria", ctrl.listSituazioneFinanziaria);
router.post("/situazione-finanziaria/:id/assign", ctrl.assignFantaTeamToSituazione);
router.post("/situazione-finanziaria/:id/crediti", ctrl.adjustCrediti);
router.get("/parametri", ctrl.listParametri);
router.post("/parametri/init-ruoli-tm", ctrl.initRuoliTM);
router.post("/parametri/:id", ctrl.saveParametro);
router.get("/rosa", ctrl.listRosa);
router.get("/rosa/:fantaTeamId", ctrl.showRosa);
router.post("/rosa/:fantaTeamId", ctrl.saveRosa);
router.post("/sync-quotazioni", ctrl.syncQuotazioni);
router.get("/sync-transfermarkt", ctrl.showSyncTransfermarkt);
router.post("/sync-transfermarkt/scrape", ctrl.runScrapeTransfermarkt);
router.post("/sync-transfermarkt/import", ctrl.importTransfermarkt);

module.exports = router;
