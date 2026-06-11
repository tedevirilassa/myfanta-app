/**
 * scripts/prod-logs.js
 * Mostra gli ultimi log del server su fantaserver via SSH.
 */
"use strict";
require("dotenv").config();
const { Client } = require("ssh2");

const SSH_HOST    = process.env.PROD_SSH_HOST    || "fantaserver";
const SSH_PORT    = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER    = process.env.PROD_SSH_USER    || "fantauser";
const SSH_PASS    = process.env.PROD_SSH_PASSWORD;
const REMOTE_PATH = process.env.PROD_REMOTE_PATH || "C:\\user\\fantauser\\fantaprod";

const LINES = process.argv[2] || "80";

if (!SSH_PASS) { console.error("PROD_SSH_PASSWORD mancante in .env"); process.exit(1); }

function execRemote(conn, cmd) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      let out = "";
      stream.on("data", (d) => { out += d; process.stdout.write(d); });
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", () => res(out));
    });
  });
}

async function main() {
  const conn = new Client();
  await new Promise((res, rej) =>
    conn.on("ready", res).on("error", rej).connect({
      host: SSH_HOST, port: SSH_PORT,
      username: SSH_USER, password: SSH_PASS,
      readyTimeout: 20000,
    })
  );

  // Mostra le ultime N righe del log
  await execRemote(conn, `powershell -Command "Get-Content '${REMOTE_PATH}\\logs\\server.log' -Tail ${LINES} -ErrorAction SilentlyContinue"`);

  conn.end();
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
