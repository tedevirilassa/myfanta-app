// src/routes/admin.js
const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/admin.controller");
const rinnoviCtrl = require("../controllers/rinnovi.controller");
const { attivaTrattativeDifferite, showAdminDifferiti, adminModificaDifferito, adminAnnullaDifferito } = require("../controllers/mercato.controller");

// ── Stop impersonate (PRIMA di requireAdmin!) ────────────
// Accessibile anche all'utente impersonato (potrebbe non essere admin):
// basta requireAuth. Necessaria per uscire dall'impersonificazione.
router.post("/stop-impersonate", requireAuth, ctrl.stopImpersonate);

// Tutte le altre rotte admin richiedono autenticazione + ruolo ADMIN
router.use(requireAuth, requireAdmin);

// ── Job automatico: attiva trasferimenti differiti (debounce 1h) ─────────────
let _ultimoCheckDifferiti = 0;
router.use(async (req, res, next) => {
  const ora = Date.now();
  if (ora - _ultimoCheckDifferiti > 60 * 60 * 1000) {
    _ultimoCheckDifferiti = ora;
    attivaTrattativeDifferite().catch((e) => console.error("[job differiti]", e.message));
  }
  next();
});

// ── Impersonificazione ─────────────────────────────────
router.post("/users/:id/impersonate", ctrl.startImpersonate);

// ── Rinnovi (admin) ──────────────────────────────────────
router.get("/rinnovi",            rinnoviCtrl.showAdminRinnovi);
router.post("/rinnovi/finalizza", rinnoviCtrl.finalizzaRinnovi);

// ── Svincoli giocatori inattivi ─────────────────────────
router.get("/svincoli-inattivi",          ctrl.listSvincoliInattivi);
router.post("/svincoli-inattivi/applica", ctrl.approveSvincoliInattivi);

// ── Fine stagione (rollover 30 giugno) ──────────────────
const fineStagioneCtrl = require("../controllers/fine-stagione.controller");
router.get("/fine-stagione",         fineStagioneCtrl.showFineStagione);
router.post("/fine-stagione/esegui", fineStagioneCtrl.eseguiFineStagione);
// Step manuali (preview + esegui, ognuno in transazione a sé, ordine libero)
router.post("/fine-stagione/step/1/preview", fineStagioneCtrl.previewStep1);
router.post("/fine-stagione/step/1/esegui",  fineStagioneCtrl.eseguiStep1);
router.post("/fine-stagione/step/2/preview", fineStagioneCtrl.previewStep2);
router.post("/fine-stagione/step/2/esegui",  fineStagioneCtrl.eseguiStep2);
router.post("/fine-stagione/step/2b/preview", fineStagioneCtrl.previewStep2B);
router.post("/fine-stagione/step/2b/esegui",  fineStagioneCtrl.eseguiStep2B);
router.post("/fine-stagione/step/2b/annulla", fineStagioneCtrl.annullaStep2B);
router.post("/fine-stagione/step/3/preview", fineStagioneCtrl.previewStep3);
router.post("/fine-stagione/step/3/esegui",  fineStagioneCtrl.eseguiStep3);
router.post("/fine-stagione/step/4/preview", fineStagioneCtrl.previewStep4);
router.post("/fine-stagione/step/4/esegui",  fineStagioneCtrl.eseguiStep4);

router.get("/users", ctrl.listUsers);
router.post("/users/:id/save-fields", ctrl.saveUserFields);
router.get("/pannello", ctrl.showPannello);
router.get("/contratti/riepilogo", ctrl.listContrattiRiepilogo);
router.get("/contratti/nuovo", ctrl.showNuovoContratto);
router.post("/contratti/nuovo", ctrl.saveNuovoContratto);
router.post("/contratti/:id/edit", ctrl.saveEditContratto);
// /delete e /annulla fanno la stessa cosa: annullano la stipula e ripristinano
// la situazione finanziaria precedente. Manteniamo entrambe le route per
// retro-compatibilità dell'UI (drawer "🗑 Elimina" e ↶ "Annulla stipula").
router.post("/contratti/:id/delete", ctrl.annullaContratto);
router.post("/contratti/:id/annulla", ctrl.annullaContratto);
router.get("/log", ctrl.listLog);
router.post("/log/:id/rollback", ctrl.rollbackLog);
router.get("/users/invite", ctrl.showInvite);
router.post("/users/invite", ctrl.inviteUser);
router.get("/users/:id/edit-profile", ctrl.showEditProfile);
router.post("/users/:id/edit-profile", ctrl.saveEditProfile);
router.post("/users/:id/inline-profile", ctrl.inlineEditUser);
router.post("/users/:id/toggle", ctrl.toggleActive);
router.post("/users/:id/delete", ctrl.deleteUser);
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
router.get("/calendario-azioni", ctrl.showCalendarioAzioni);
router.post("/calendario-azioni/date", ctrl.saveCalendarioDate);
router.get("/parametri", ctrl.listParametri);
router.post("/parametri/serie-a-teams", ctrl.saveSerieATeams);
router.post("/parametri/serie-a-catalogo/add", ctrl.addSerieATeam);
router.post("/parametri/serie-a-catalogo/remove", ctrl.removeSerieATeam);
router.post("/parametri/init-ruoli-tm", ctrl.initRuoliTM);
router.post("/parametri/:id", ctrl.saveParametro);
router.get("/rosa", ctrl.listRosa);
router.get("/rosa/:fantaTeamId", ctrl.showRosa);
router.post("/rosa/:fantaTeamId", ctrl.saveRosa);
router.get("/premi/classifica", ctrl.showPremiClassifica);
router.post("/premi/classifica", ctrl.savePremiClassifica);
router.get("/premi",       ctrl.showPremiCombinati);
router.get("/premi/:tipo", ctrl.showPremi);
router.post("/premi/:tipo", ctrl.savePremi);
router.post("/sync-quotazioni", ctrl.syncQuotazioni);
router.get("/sync-transfermarkt", ctrl.showSyncTransfermarkt);
router.post("/sync-transfermarkt/scrape", ctrl.runScrapeTransfermarkt);
router.post("/sync-transfermarkt/import", ctrl.importTransfermarkt);
router.get("/realign-ruoli", ctrl.showRealignRuoli);
router.post("/realign-ruoli/apply", ctrl.applyRealignRuoli);

router.get("/mercato/differiti",              showAdminDifferiti);
router.post("/mercato/differiti/:id/modifica", adminModificaDifferito);
router.post("/mercato/differiti/:id/annulla",  adminAnnullaDifferito);

module.exports = router;
