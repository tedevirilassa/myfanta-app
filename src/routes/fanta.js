// src/routes/fanta.js
const express = require("express");
const router  = express.Router();
const { requireAuth } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/fanta.controller");
const rinnoviCtrl = require("../controllers/rinnovi.controller");

router.use(requireAuth);

router.get("/classifica",        ctrl.showClassifica);
router.get("/riepilogo",         ctrl.showRiepilogo);
router.get("/presidente/:nome",  ctrl.showPresidente);
router.get("/giocatori",         ctrl.showGiocatori);
router.get("/lista-giocatori",   ctrl.showListaGiocatori);
router.get("/finanze",           ctrl.showFinanze);
router.get("/diario",            ctrl.showDiario);
router.get("/log",               ctrl.showLog);
router.get("/rose",              ctrl.showRose);
router.get("/rose/:fantaTeamId", ctrl.showRosaDettaglio);
router.get("/regolamento",       ctrl.showRegolamento);

// ── Rinnovi ──────────────────────────────────────────────
router.get("/rinnovi",                  rinnoviCtrl.showMieProposte);
router.get("/rinnovi/check",            ctrl.showRinnoviCheck);
router.get("/movimenti",                ctrl.showMovimenti);
router.get("/rinnovi/pubblico",         rinnoviCtrl.showRinnoviPubblico);
router.post("/rinnovi/proposte",        rinnoviCtrl.createProposta);
router.post("/rinnovi/proposte/:id/delete", rinnoviCtrl.deleteProposta);
router.post("/rinnovi/proposte/ordina", express.json(), rinnoviCtrl.reorderProposte);

// redirect di default
router.get("/", (req, res) => res.redirect("/fanta/classifica"));

module.exports = router;
