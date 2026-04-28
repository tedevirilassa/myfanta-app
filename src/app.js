
// src/app.js
require("dotenv").config();

const express = require("express");
const path = require("path");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");

// Routes
const healthRoutes = require("./routes/health");
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const fantaRoutes = require("./routes/fanta");
const profileRoutes = require("./routes/profile");

// Middleware
const { requireAuth } = require("./middleware/auth.middleware");

// Error middleware
const { notFoundHandler, errorHandler } = require("./middleware/error");

const app = express();

/**
 * 1) Trust proxy (utile se in futuro metti reverse proxy; innocuo in LAN)
 *    Se non ti serve, puoi commentare.
 */
app.set("trust proxy", 1);

/**
 * 2) View engine – EJS
 */
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

/**
 * 3) Logging HTTP (solo in dev)
 */
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

/**
 * 4) Body parsing
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * 5) Cookie parsing (utile per auth/session)
 */
app.use(cookieParser());

/**
 * 6) Static files
 */
app.use("/public", express.static(path.join(__dirname, "public")));

/**
 * 7) Routes
 */
app.get("/", requireAuth, (req, res) => {
  res.render("dashboard", { currentUser: req.user });
});

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/fanta", fantaRoutes);
app.use("/profilo", profileRoutes);
app.use("/health", healthRoutes);

/**
 * 8) 404 handler
 */
app.use(notFoundHandler);

/**
 * 9) Error handler centralizzato
 */
app.use(errorHandler);

module.exports = app;

