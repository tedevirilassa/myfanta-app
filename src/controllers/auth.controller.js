// src/controllers/auth.controller.js
const jwt = require("jsonwebtoken");
const authService = require("../services/auth.service");
const { COOKIE_NAME } = require("../middleware/auth.middleware");
const { logAction } = require("../services/log.service");

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 8 * 60 * 60 * 1000, // 8 ore
};

// GET /auth/login
function showLogin(req, res) {
  if (req.cookies[COOKIE_NAME]) {
    // Già autenticato: tenta redirect alla home; il middleware penserà al resto
    return res.redirect("/");
  }
  res.render("auth/login", { error: null });
}

// POST /auth/login
async function login(req, res) {
  const { email, password } = req.body;

  try {
    const user = await authService.authenticate(email, password);

    const token = jwt.sign(
      { sub: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);

    logAction({ azione: "LOGIN", entita: "utente", entitaId: user.id, adminId: user.id });

    if (user.mustChangePassword) {
      return res.redirect("/auth/change-password");
    }
    return res.redirect("/");
  } catch (err) {
    return res.render("auth/login", { error: err.message });
  }
}

// GET /auth/change-password
function showChangePassword(req, res) {
  res.render("auth/change-password", { error: null, currentUser: req.user });
}

// POST /auth/change-password
async function changePassword(req, res) {
  const { password, confirmPassword } = req.body;

  if (!password || password.length < 8) {
    return res.render("auth/change-password", {
      error: "La password deve essere di almeno 8 caratteri.",
      currentUser: req.user,
    });
  }
  if (password !== confirmPassword) {
    return res.render("auth/change-password", {
      error: "Le password non coincidono.",
      currentUser: req.user,
    });
  }

  try {
    await authService.changePassword(req.user.id, password);

    // Ri-emetti il token senza mustChangePassword
    const token = jwt.sign(
      { sub: req.user.id, role: req.user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);

    logAction({ azione: "UPDATE", entita: "password", entitaId: req.user.id, adminId: req.user.id });

    return res.redirect("/");
  } catch (err) {
    return res.render("auth/change-password", {
      error: err.message,
      currentUser: req.user,
    });
  }
}

// POST /auth/logout
function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.redirect("/auth/login");
}

module.exports = { showLogin, login, showChangePassword, changePassword, logout };
