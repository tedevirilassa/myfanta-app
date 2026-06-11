"use strict";
require("dotenv").config();
const { Client } = require("ssh2");

const SSH_HOST = process.env.PROD_SSH_HOST || "fantaserver";
const SSH_PORT = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER = process.env.PROD_SSH_USER || "fantauser";
const SSH_PASS = process.env.PROD_SSH_PASSWORD;
const REMOTE_PATH = "C:\\user\\fantauser\\fantaprod";

async function main() {
  const conn = new Client();
  await new Promise((res, rej) =>
    conn.on("ready", res).on("error", rej).connect({
      host: SSH_HOST, port: SSH_PORT, username: SSH_USER, password: SSH_PASS, readyTimeout: 20000,
    })
  );
  console.log("SSH OK");

  // Crea cartella logs
  await new Promise(res => {
    conn.exec(`powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${REMOTE_PATH}\\logs' | Out-Null"`, (err, stream) => {
      if (err) { res(); return; }
      stream.on("close", res); stream.on("data", () => {}); stream.stderr.on("data", () => {});
    });
  });

  // Avvia il server
  console.log("Avvio server...");
  await new Promise(res => {
    conn.exec(
      `cd /d ${REMOTE_PATH} && node src\\server.js >> ${REMOTE_PATH}\\logs\\server.log 2>> ${REMOTE_PATH}\\logs\\server-error.log`,
      (err, stream) => {
        if (err) { console.error("Errore:", err.message); res(); return; }
        setTimeout(() => { stream.destroy(); conn.destroy(); res(); }, 3000);
      }
    );
  });
  console.log("Server avviato.");
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
