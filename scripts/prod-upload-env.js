/**
 * scripts/prod-upload-env.js
 * Carica il .env di produzione su fantaserver via SSH+SFTP.
 * Il contenuto viene costruito da process.env (già caricato dal .env locale).
 */
"use strict";
require("dotenv").config();
const { Client } = require("ssh2");
const { Writable } = require("stream");

const SSH_HOST    = process.env.PROD_SSH_HOST    || "fantaserver";
const SSH_PORT    = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER    = process.env.PROD_SSH_USER    || "fantauser";
const SSH_PASS    = process.env.PROD_SSH_PASSWORD;
const REMOTE_PATH = process.env.PROD_REMOTE_PATH || "C:\\user\\fantauser\\fantaprod";

if (!SSH_PASS) { console.error("PROD_SSH_PASSWORD mancante in .env"); process.exit(1); }

// Contenuto del .env di PROD
// Il DATABASE_URL_PROD punta a fantaserver:5432 ma su prod bisogna usare localhost
const prodDbUrl = (process.env.DATABASE_URL_PROD || "").replace(/@[^@/]+:(\d+)\//, "@localhost:$1/");

const ENV_CONTENT = [
  `NODE_ENV=production`,
  `HOST=0.0.0.0`,
  `PORT=${process.env.PORT || 3000}`,
  ``,
  `# DB prod (connessione locale su fantaserver)`,
  `DATABASE_URL="${prodDbUrl}"`,
  ``,
  `JWT_SECRET="${process.env.JWT_SECRET}"`,
  ``,
  `SHEETS_ID="${process.env.SHEETS_ID}"`,
  `SHEETS_RIEPILOGO_GID="${process.env.SHEETS_RIEPILOGO_GID}"`,
  ``,
  `SMTP_HOST=${process.env.SMTP_HOST}`,
  `SMTP_PORT=${process.env.SMTP_PORT}`,
  `SMTP_USER=${process.env.SMTP_USER}`,
  `SMTP_PASS=${process.env.SMTP_PASS}`,
  `SMTP_FROM="${process.env.SMTP_FROM}"`,
  ``,
  `FRONTEND_BASE_URL=http://fantaserver:${process.env.PORT || 3000}`,
].join("\r\n");

async function main() {
  const conn = new Client();
  await new Promise((res, rej) =>
    conn.on("ready", res).on("error", rej).connect({
      host: SSH_HOST, port: SSH_PORT,
      username: SSH_USER, password: SSH_PASS,
      readyTimeout: 20000,
    })
  );
  console.log("SSH OK");

  const sftp = await new Promise((res, rej) =>
    conn.sftp((err, s) => (err ? rej(err) : res(s)))
  );

  const remotePath = REMOTE_PATH + "\\.env";
  await new Promise((res, rej) => {
    const writeStream = sftp.createWriteStream(remotePath);
    writeStream.on("error", rej);
    writeStream.on("close", res);
    writeStream.end(Buffer.from(ENV_CONTENT, "utf8"));
  });

  console.log(`✓ .env caricato su ${remotePath}`);
  sftp.end();
  conn.end();
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
