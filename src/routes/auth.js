// src/routes/auth.js
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/auth.controller");

router.get("/login", ctrl.showLogin);
router.post("/login", ctrl.login);

router.get("/change-password", requireAuth, ctrl.showChangePassword);
router.post("/change-password", requireAuth, ctrl.changePassword);

router.post("/logout", ctrl.logout);

module.exports = router;
