/**
 * scripts/restart-prod.js
 * Riavvia il server Node.js su fantaserver via SSH.
 * Cerca il processo node che esegue server.js e lo killa (il service manager lo riavvia).
 */
"use strict";
require("dotenv").config();
const { Client } = require("ssh2");

const SSH_HOST = process.env.PROD_SSH_HOST || "fantaserver";
const SSH_PORT = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER = process.env.PROD_SSH_USER || "fantauser";
const SSH_PASS = process.env.PROD_SSH_PASSWORD;

if (!SSH_PASS) { console.error("PROD_SSH_PASSWORD mancante in .env"); process.exit(1); }

function execRemote(conn, cmd, ignoreError = false) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return ignoreError ? res("") : rej(err);
      let out = ""; let errOut = "";
      stream.on("data", (d) => { out += d; });
      stream.stderr.on("data", (d) => { errOut += d; });
      stream.on("close", (code) => {
        if (code !== 0 && !ignoreError) {
          console.log(errOut.trim());
          return rej(new Error(`Exit ${code}`));
        }
        res((out + errOut).trim());
      });
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
  console.log("SSH OK");

  // Trova il PID del processo node che esegue server.js
  const pids = await execRemote(conn, `wmic process where "CommandLine like '%server.js%' and Name='node.exe'" get ProcessId /value`, true);
  console.log("Output WMIC:", pids);

  const match = pids.match(/ProcessId=(\d+)/g);
  if (!match || match.length === 0) {
    console.log("Nessun processo attivo. Avvio il server...");
    const remotePath = process.env.PROD_REMOTE_PATH || "C:\\user\\fantauser\\fantaprod";
    // Crea la cartella logs se non esiste, poi avvia con Start-Process (detached, sopravvive alla sessione SSH)
    // Crea la cartella logs se non esiste
    await execRemote(conn, `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${remotePath}\\logs' | Out-Null"`, true);

    // Avvia il server direttamente (su Windows OpenSSH i processi sopravvivono alla disconnessione)
    // Non aspettiamo la chiusura dello stream — chiudiamo subito la connessione
    console.log("Avvio il server...");
    await new Promise((res) => {
      conn.exec(`cd /d ${remotePath} && node src\\server.js >> ${remotePath}\\logs\\server.log 2>> ${remotePath}\\logs\\server-error.log`, (err, stream) => {
        if (err) { console.error("Errore exec:", err.message); res(); return; }
        // Chiudi la connessione SSH dopo 2 secondi (il processo sopravvive)
        setTimeout(() => { stream.destroy(); conn.destroy(); res(); }, 2000);
      });
    });
    console.log("Server avviato. Verifica tra qualche secondo con npm run prod:restart.");
    process.exit(0);
  }

  for (const m of match) {
    const pid = m.split("=")[1];
    console.log(`Kill PID ${pid}...`);
    await execRemote(conn, `taskkill /PID ${pid} /F`, true);
    console.log(`  PID ${pid} terminato`);
  }

  conn.end();
  console.log("Fatto. Il service manager dovrebbe riavviare il server automaticamente.");
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
