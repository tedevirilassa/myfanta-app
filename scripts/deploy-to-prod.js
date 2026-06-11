/**
 * scripts/deploy-to-prod.js
 *
 * Sincronizza il codice dell'app su fantasserver via SSH + SFTP.
 * Non usa Robocopy/SMB — funziona con sola connessione SSH.
 *
 * Variabili .env:
 *   PROD_SSH_HOST       (default: "fantasserver")
 *   PROD_SSH_PORT       (default: 22)
 *   PROD_SSH_USER       (default: "fantauser")
 *   PROD_SSH_PASSWORD   password SSH
 *   PROD_REMOTE_PATH    cartella remota (default: C:\user\fantauser\fantaprod)
 *
 * Uso:
 *   node scripts/deploy-to-prod.js              → sync file + npm ci + prisma generate
 *   node scripts/deploy-to-prod.js --dry-run    → lista file senza copiare
 *   node scripts/deploy-to-prod.js --no-install → solo sync file, senza npm ci
 */

"use strict";

require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const { Client } = require("ssh2");

// ─── Config ──────────────────────────────────────────────────────────────────

const SSH_HOST    = process.env.PROD_SSH_HOST     || "fantaserver";
const SSH_PORT    = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER    = process.env.PROD_SSH_USER     || "fantauser";
const SSH_PASS    = process.env.PROD_SSH_PASSWORD;
const REMOTE_PATH = process.env.PROD_REMOTE_PATH  || "C:\\user\\fantauser\\fantaprod";

const DRY_RUN    = process.argv.includes("--dry-run");
const NO_INSTALL = process.argv.includes("--no-install");

if (!SSH_PASS) {
  console.error("PROD_SSH_PASSWORD mancante in .env");
  process.exit(1);
}

// ─── Cartelle/file da sincronizzare ──────────────────────────────────────────

const LOCAL_ROOT = path.resolve(__dirname, "..");

const INCLUDE_DIRS  = ["src", "prisma", "public"];
const INCLUDE_FILES = ["package.json", "package-lock.json", "nodemon.json", "prisma.config.ts"];

const EXCLUDE_NAMES = new Set([
  "node_modules", ".git", "backups", "generated", ".vscode",
  ".vscode-server", "tmp",
]);
const EXCLUDE_EXT = new Set([".log", ".rar", ".zip", ".7z"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[deploy] ${msg}`); }
function warn(msg) { console.warn(`[deploy] WARN ${msg}`); }

function walkDir(dir, baseDir) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const name of fs.readdirSync(dir)) {
    if (EXCLUDE_NAMES.has(name)) continue;
    if (EXCLUDE_EXT.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      entries.push(...walkDir(full, baseDir));
    } else {
      entries.push(path.relative(baseDir, full));
    }
  }
  return entries;
}

function toRemote(relPath) {
  return REMOTE_PATH + "\\" + relPath.replace(/\//g, "\\");
}

function sftpMkdir(sftp, dir) {
  return new Promise((res) => sftp.mkdir(dir, (err) => res(err)));
}

async function ensureRemoteDir(sftp, remoteFile) {
  const parts = remoteFile.split("\\");
  parts.pop(); // rimuove filename
  let cur = "";
  for (const p of parts) {
    cur = cur ? cur + "\\" + p : p;
    if (/^[A-Za-z]:$/.test(cur)) continue;
    await sftpMkdir(sftp, cur);
  }
}

function sftpPut(sftp, local, remote) {
  return new Promise((res, rej) =>
    sftp.fastPut(local, remote, (err) => (err ? rej(err) : res()))
  );
}

function execRemote(conn, cmd) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      let out = "";
      stream.on("data", (d) => { out += d; process.stdout.write(d); });
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", (code) =>
        code === 0 ? res(out) : rej(new Error(`Exit code ${code}`))
      );
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const files = [];
  for (const dir of INCLUDE_DIRS) {
    for (const rel of walkDir(path.join(LOCAL_ROOT, dir), LOCAL_ROOT)) {
      files.push(rel);
    }
  }
  for (const f of INCLUDE_FILES) {
    if (fs.existsSync(path.join(LOCAL_ROOT, f))) files.push(f);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Deploy DEV -> PROD (fantaserver via SSH+SFTP)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Host   : ${SSH_HOST}:${SSH_PORT}  utente: ${SSH_USER}`);
  console.log(`  Dest   : ${REMOTE_PATH}`);
  console.log(`  File   : ${files.length}`);
  console.log(`  Modalità: ${DRY_RUN ? "DRY-RUN" : "REALE"}  install: ${NO_INSTALL ? "no" : "sì"}\n`);

  if (DRY_RUN) {
    files.forEach((f) => console.log("  >", f));
    return;
  }

  // Connessione SSH
  const conn = new Client();
  await new Promise((res, rej) =>
    conn.on("ready", res).on("error", rej).connect({
      host: SSH_HOST, port: SSH_PORT,
      username: SSH_USER, password: SSH_PASS,
      readyTimeout: 20000,
    })
  );
  log("Connessione SSH OK");

  const sftp = await new Promise((res, rej) =>
    conn.sftp((err, s) => (err ? rej(err) : res(s)))
  );

  let ok = 0; let ko = 0;
  for (const rel of files) {
    const remote = toRemote(rel);
    try {
      await ensureRemoteDir(sftp, remote);
      await sftpPut(sftp, path.join(LOCAL_ROOT, rel), remote);
      ok++;
      if (ok % 20 === 0) log(`  ${ok}/${files.length} caricati...`);
    } catch (e) {
      warn(`${rel}: ${e.message}`);
      ko++;
    }
  }
  log(`Upload: ${ok} OK, ${ko} errori`);

  if (!NO_INSTALL) {
    console.log("\n-- npm ci --");
    await execRemote(conn, `cd /d "${REMOTE_PATH}" && npm ci --omit=dev --ignore-scripts`);
    console.log("\n-- prisma generate --");
    await execRemote(conn, `cd /d "${REMOTE_PATH}" && npx prisma generate`);
    log("Install OK");
  }

  sftp.end();
  conn.end();
  log("Deploy completato. Ricordati di riavviare il server su fantaserver.");
}

main().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
