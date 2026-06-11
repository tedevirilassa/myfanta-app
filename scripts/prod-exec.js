/**
 * scripts/prod-exec.js
 * Esegue un comando arbitrario su fantaserver via SSH.
 * Uso: node scripts/prod-exec.js "il comando"
 */
"use strict";
require("dotenv").config();
const { Client } = require("ssh2");

const SSH_HOST    = process.env.PROD_SSH_HOST    || "fantaserver";
const SSH_PORT    = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER    = process.env.PROD_SSH_USER    || "fantauser";
const SSH_PASS    = process.env.PROD_SSH_PASSWORD;

if (!SSH_PASS) { console.error("PROD_SSH_PASSWORD mancante in .env"); process.exit(1); }

const CMD = process.argv.slice(2).join(" ");
if (!CMD) { console.error("Uso: node scripts/prod-exec.js \"comando\""); process.exit(1); }

async function main() {
  const conn = new Client();
  await new Promise((res, rej) =>
    conn.on("ready", res).on("error", rej).connect({
      host: SSH_HOST, port: SSH_PORT,
      username: SSH_USER, password: SSH_PASS,
      readyTimeout: 20000,
    })
  );
  await new Promise((res) => {
    conn.exec(CMD, (err, stream) => {
      if (err) { console.error(err.message); conn.end(); return res(); }
      stream.on("data", (d) => process.stdout.write(d));
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", () => { conn.end(); res(); });
    });
  });
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
