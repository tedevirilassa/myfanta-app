// src/routes/fanta.js
const express = require("express");
const router  = express.Router();
const { requireAuth } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/fanta.controller");

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

// redirect di default
router.get("/", (req, res) => res.redirect("/fanta/classifica"));

module.exports = router;
