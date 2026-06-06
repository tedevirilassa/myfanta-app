// src/routes/mercato.js
const express = require("express");
const router  = express.Router();
const { requireAuth } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/mercato.controller");

router.use(requireAuth);

// ── Pagine EJS ────────────────────────────────────────────────────────────────
router.get("/invia-offerta", ctrl.showInviaOfferta);
router.get("/inbox",         ctrl.showInbox);

// ── API JSON ──────────────────────────────────────────────────────────────────
router.post  ("/offerta",                ctrl.creaOfferta);
router.patch ("/offerta/:id/risposta",   ctrl.rispondiOfferta);
router.post  ("/offerta/:id/finalizza",  ctrl.finalizzaTransferimento);

// ── Job admin: attiva trasferimenti differiti la cui decorrenza è raggiunta ───
router.post("/job/attiva-differiti", async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Solo admin." });
  const risultati = await ctrl.attivaTrattativeDifferite();
  res.json(risultati);
});

module.exports = router;
