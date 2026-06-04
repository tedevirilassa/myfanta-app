// src/middleware/auth.middleware.js
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const { runWithContext } = require("../services/log.service");

const COOKIE_NAME = "myfanta_token";

/**
 * Verifica il JWT nel cookie e popola req.user.
 * Redirige a /auth/login se il token manca o non è valido.
 * Redirige a /auth/change-password se mustChangePassword è true.
 *
 * Supporto impersonificazione: se il JWT contiene la claim `impersonator`
 * (id dell'admin originale), carica come req.user l'utente target (`sub`),
 * popola req.impersonatorId/req.impersonator e attiva l'AsyncLocalStorage
 * context per log.service. Tutti i logAction successivi nella request
 * annoteranno automaticamente `impersonatedBy`.
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

    // ── Impersonificazione ────────────────────────────────────────────────
    if (payload.impersonator && payload.impersonator !== user.id) {
      const impersonator = await prisma.user.findUnique({
        where: { id: payload.impersonator },
        select: { id: true, email: true, nickname: true, role: true, isActive: true },
      });
      if (impersonator && impersonator.isActive && impersonator.role === "ADMIN") {
        req.impersonatorId = impersonator.id;
        req.impersonator = impersonator;
        // Esegui next() in ALS context → logAction auto-tagga
        return runWithContext(
          { impersonatorId: impersonator.id, impersonator },
          () => proceedAfterAuth(req, res, next, user)
        );
      }
      // Impersonator non valido → ignora claim, sessione resta come utente target
    }

    return proceedAfterAuth(req, res, next, user);
  } catch {
    res.clearCookie(COOKIE_NAME);
    return res.redirect("/auth/login");
  }
}

function proceedAfterAuth(req, res, next, user) {
  // Espone impersonator a tutte le view (banner globale nel nav)
  res.locals.impersonator = req.impersonator || null;

  // Forza il cambio password al primo accesso (NON applicato in impersonificazione:
  // l'admin non deve forzare il reset password dell'utente target)
  if (
    !req.impersonatorId &&
    user.mustChangePassword &&
    !req.originalUrl.includes("/auth/change-password") &&
    !req.originalUrl.includes("/auth/logout")
  ) {
    return res.redirect("/auth/change-password");
  }
  next();
}

/**
 * Da usare dopo requireAuth: verifica che l'utente sia ADMIN.
 * Durante impersonificazione il check si basa sul ruolo dell'utente target
 * (req.user), quindi le route admin sono inaccessibili — coerente con il
 * principio "esegui task per conto suo". L'admin deve uscire dall'impersonifi-
 * cazione (POST /admin/stop-impersonate) per riguadagnare accesso admin.
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
