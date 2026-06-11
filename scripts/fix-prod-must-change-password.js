/**
 * scripts/fix-prod-must-change-password.js
 *
 * Fix one-shot: apre il tunnel SSH verso fantasserver e resetta
 * mustChangePassword = false per tutti gli utenti già registrati.
 *
 * Da usare dopo una sync che ha copiato fantapresidenti senza quella colonna.
 *
 * Uso:
 *   node scripts/fix-prod-must-change-password.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");
const { Pool } = require("pg");

const TUNNEL_LOCAL_PORT = 5455; // porta diversa per non collidere con sync

// ─── Parse .env ──────────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File non trovato: ${abs}`);
  const result = {};
  for (const line of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    result[key] = val;
  }
  return result;
}

function resolveTilde(p) {
  if (!p) return p;
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;
}

// ─── Tunnel SSH ──────────────────────────────────────────────────────────────

function waitForPort(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryConnect = () => {
      const sock = new net.Socket();
      sock.setTimeout(600);
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("timeout", () => { sock.destroy(); retry(); });
      sock.once("error", () => { sock.destroy(); retry(); });
      sock.connect(port, "127.0.0.1");
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error(`Timeout porta ${port}`));
      else setTimeout(tryConnect, 600);
    };
    tryConnect();
  });
}

function startSshTunnel({ sshHost, sshPort, sshUser, sshKeyPath, remoteDbHost, remoteDbPort, localPort }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-N",
      "-L", `${localPort}:${remoteDbHost}:${remoteDbPort}`,
      "-p", String(sshPort || 22),
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "BatchMode=yes",
    ];
    if (sshKeyPath) args.push("-i", resolveTilde(sshKeyPath));
    args.push(`${sshUser}@${sshHost}`);

    console.log(`[fix-prod] Apertura tunnel SSH: ${sshUser}@${sshHost}:${sshPort}`);
    const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", d => { const m = d.toString().trim(); if (m) console.log(`[SSH] ${m}`); });
    proc.on("error", err => reject(new Error(`SSH error: ${err.message}`)));
    proc.on("exit", (code) => { if (code !== null && code !== 0) reject(new Error(`SSH exit ${code}`)); });

    waitForPort(localPort, 20000)
      .then(() => { console.log(`[fix-prod] Tunnel attivo su localhost:${localPort}`); resolve(proc); })
      .catch(err => { proc.kill(); reject(err); });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const env = parseEnvFile(path.join(__dirname, "../.env"));

  const remoteUrl = env.DATABASE_URL_PROD;
  if (!remoteUrl) throw new Error("DATABASE_URL_PROD mancante in .env");

  let parsedUrl;
  try { parsedUrl = new URL(remoteUrl); }
  catch { throw new Error(`DATABASE_URL_PROD non valido: ${remoteUrl}`); }

  const remoteDbPort = parseInt(parsedUrl.port || "5432", 10);
  const remoteDbName = parsedUrl.pathname.replace(/^\//, "").split("?")[0];
  const remoteDbUser = decodeURIComponent(parsedUrl.username);
  const remoteDbPassword = decodeURIComponent(parsedUrl.password);
  const remoteDbHost = env.PROD_DB_REMOTE_HOST || "localhost";

  const sshHost = env.PROD_SSH_HOST || parsedUrl.hostname;
  const sshPort = parseInt(env.PROD_SSH_PORT || "22", 10);
  const sshUser = env.PROD_SSH_USER;
  const sshKeyPath = env.PROD_SSH_KEY || null;

  if (!sshUser) throw new Error("PROD_SSH_USER mancante in .env");

  const encodedPassword = encodeURIComponent(remoteDbPassword);
  const tunnelUrl = `postgresql://${encodeURIComponent(remoteDbUser)}:${encodedPassword}@127.0.0.1:${TUNNEL_LOCAL_PORT}/${remoteDbName}`;

  let sshProcess = null;
  const cleanup = () => { if (sshProcess && !sshProcess.killed) { console.log("[fix-prod] Chiusura tunnel SSH..."); sshProcess.kill(); } };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    sshProcess = await startSshTunnel({ sshHost, sshPort, sshUser, sshKeyPath, remoteDbHost, remoteDbPort, localPort: TUNNEL_LOCAL_PORT });

    const pool = new Pool({ connectionString: tunnelUrl });
    try {
      // Mostra stato prima
      const { rows: before } = await pool.query(
        `SELECT id, email, "mustChangePassword", "isActive" FROM fantapresidenti ORDER BY id`
      );
      console.log("\n[fix-prod] Utenti su PROD prima del fix:");
      console.table(before);

      // Reset mustChangePassword = false per tutti
      const { rowCount } = await pool.query(
        `UPDATE fantapresidenti SET "mustChangePassword" = false WHERE "mustChangePassword" = true`
      );
      console.log(`\n[fix-prod] Reset mustChangePassword=false: ${rowCount} utenti aggiornati.`);

      // Mostra stato dopo
      const { rows: after } = await pool.query(
        `SELECT id, email, "mustChangePassword", "isActive" FROM fantapresidenti ORDER BY id`
      );
      console.log("\n[fix-prod] Utenti su PROD dopo il fix:");
      console.table(after);

      console.log("\n[fix-prod] FATTO. Gli utenti ora possono accedere con la loro password.");
      console.log(
        "[fix-prod] NOTA: le passwordHash sono quelle copiate dal DB locale.\n" +
        "           Se gli utenti non conoscono la password locale, usa il pannello Admin\n" +
        "           > Gestione Utenti > Reimposta password per resettare singolarmente.\n" +
        "           L'admin (mrdownload@gmail.com) può accedere con la password locale."
      );
    } finally {
      await pool.end();
    }
  } finally {
    cleanup();
  }
}

main().catch(err => { console.error("\nERRORE:", err.message); process.exit(1); });
