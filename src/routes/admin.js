// src/routes/admin.js
const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/admin.controller");

// Tutte le rotte admin richiedono autenticazione + ruolo ADMIN
router.use(requireAuth, requireAdmin);

router.get("/users", ctrl.listUsers);
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
router.post("/tools/seed-giocatori", ctrl.runSeedGiocatori);

module.exports = router;
