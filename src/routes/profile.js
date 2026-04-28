// src/routes/profile.js
const express = require("express");
const router  = express.Router();
const { requireAuth } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/profile.controller");

router.use(requireAuth);

router.get("/",  ctrl.showProfile);
router.post("/", ctrl.saveProfile);

module.exports = router;
