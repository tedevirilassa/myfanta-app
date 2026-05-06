// src/middleware/auth.middleware.js
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

const COOKIE_NAME = "myfanta_token";

/**
 * Verifica il JWT nel cookie e popola req.user.
 * Redirige a /auth/login se il token manca o non è valido.
 * Redirige a /auth/change-password se mustChangePassword è true.
 */
async function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.redirect("/auth/login");
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { fantaTeam: true },
    });

    if (!user || !user.isActive) {
      res.clearCookie(COOKIE_NAME);
      return res.redirect("/auth/login");
    }

    req.user = user;

    // Forza il cambio password al primo accesso
    if (
      user.mustChangePassword &&
      !req.originalUrl.includes("/auth/change-password") &&
      !req.originalUrl.includes("/auth/logout")
    ) {
      return res.redirect("/auth/change-password");
    }

    next();
  } catch {
    res.clearCookie(COOKIE_NAME);
    return res.redirect("/auth/login");
  }
}

/**
 * Da usare dopo requireAuth: verifica che l'utente sia ADMIN.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).render("error", {
      message: "Accesso non autorizzato.",
      currentUser: req.user || null,
    });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, COOKIE_NAME };
