/**
 * scripts/deploy-to-prod.js
 *
 * Sincronizza la cartella dell'app da mrpower (DEV) a fantaserver (PROD) via Robocopy + SMB.
 * Non tocca il database: per quello esiste `npm run prod:migrate-and-sync`.
 *
 * Cosa fa:
 *   1. Lancia `robocopy <projectRoot> <UNC_path> /MIR /XD … /XF …` per replicare la cartella
 *      (esclude node_modules, .env, backups, .git, generated, log, .vscode, ecc.)
 *   2. (opzionale, con --install) tenta `npm ci --omit=dev` + `prisma generate` su fantaserver
 *      via PowerShell Remoting (Invoke-Command). Richiede WinRM attivo sul server.
 *   3. NON riavvia il servizio: il restart va fatto a mano.
 *
 * Requisiti:
 *   - Cartella di destinazione raggiungibile via SMB (es. \\fantaserver\c$\fantaprod)
 *   - Per --install: WinRM abilitato su fantaserver e utente con permessi
 *
 * Variabili .env:
 *   PROD_UNC_PATH         (default: \\fantaserver\c$\fantaprod)
 *   PROD_COMPUTERNAME     (default: fantaserver — usato solo per Invoke-Command con --install)
 *
 * Uso:
 *   node scripts/deploy-to-prod.js                → sync (mirror) dei file
 *   node scripts/deploy-to-prod.js --install      → sync + npm ci + prisma generate (via WinRM)
 *   node scripts/deploy-to-prod.js --no-delete    → sync senza eliminare file remoti orfani (/E al posto di /MIR)
 *   node scripts/deploy-to-prod.js --dry-run      → mostra cosa farebbe Robocopy senza copiare (/L)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DO_INSTALL = args.includes("--install");
const NO_DELETE = args.includes("--no-delete");
const DRY_RUN = args.includes("--dry-run");

// ─── Parsing .env ─────────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return {};
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function log(msg) { console.log(`[deploy-prod] ${msg}`); }
function section(t) {
  console.log(`\n${"═".repeat(60)}\n  ${t}\n${"═".repeat(60)}`);
}

// ─── Esclusioni Robocopy ─────────────────────────────────────────────────────

// Directory escluse (passate a /XD). Robocopy accetta sia nomi semplici sia
// path completi; con i nomi semplici esclude qualsiasi directory che matchi.
const EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "backups",
  "generated",
  ".vscode",
  ".vscode-server",
  "tmp",
];

// File esclusi (passati a /XF). Supportano wildcard.
const EXCLUDE_FILES = [
  ".env",
  ".env.*",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
];

// ─── Esecuzione comandi ──────────────────────────────────────────────────────

function runStreaming(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  section("Sync codice DEV → PROD (fantaserver)");

  const env = { ...parseEnvFile(".env"), ...process.env };

  const uncPath = env.PROD_UNC_PATH || "\\\\fantaserver\\c$\\fantaprod";
  const computerName = env.PROD_COMPUTERNAME || "fantaserver";

  log(`Sorgente   : ${process.cwd()}`);
  log(`Destinazione: ${uncPath}`);
  log(`Modalità   : ${DRY_RUN ? "DRY-RUN (/L)" : "ESECUZIONE REALE"}` +
      ` · ${NO_DELETE ? "/E (no delete)" : "/MIR (mirror)"}` +
      ` · ${DO_INSTALL ? "install ON" : "install OFF"}`);

  // ── Costruzione comando Robocopy ──────────────────────────────────────────
  const mirrorFlag = NO_DELETE ? "/E" : "/MIR";
  const robocopyArgs = [
    process.cwd(),
    uncPath,
    mirrorFlag,
    "/Z",          // resume mode (resilient a interruzioni)
    "/R:2",        // retry 2 volte
    "/W:3",        // wait 3s tra retry
    "/MT:8",       // multithread 8 thread
    "/NFL",        // no file list (output meno verboso)
    "/NDL",        // no directory list
    "/NP",         // no progress per file
  ];
  if (DRY_RUN) robocopyArgs.push("/L");
  if (EXCLUDE_DIRS.length) robocopyArgs.push("/XD", ...EXCLUDE_DIRS);
  if (EXCLUDE_FILES.length) robocopyArgs.push("/XF", ...EXCLUDE_FILES);

  section("Step 1 · Robocopy DEV → PROD");
  log(`robocopy ${robocopyArgs.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

  const rcCode = await runStreaming("robocopy", robocopyArgs);

  // Exit code di Robocopy: 0-7 = success (eventualmente con file copiati/skippati),
  // 8+ = errore reale.
  if (rcCode >= 8) {
    console.error(`\nERRORE: Robocopy è uscito con codice ${rcCode} (errore).`);
    process.exit(rcCode);
  }
  log(`Robocopy completato (exit code ${rcCode} — successo).`);

  // ── Install dipendenze + prisma generate (via PowerShell Remoting) ────────
  if (DO_INSTALL && !DRY_RUN) {
    section("Step 2 · npm ci + prisma generate su fantaserver (via WinRM)");

    // Path locale del progetto sul server, derivato dall'UNC.
    // \\fantaserver\c$\fantaprod  →  C:\fantaprod
    let remoteLocalPath = null;
    const m = /^\\\\[^\\]+\\([a-zA-Z])\$\\(.+)$/.exec(uncPath);
    if (m) remoteLocalPath = `${m[1].toUpperCase()}:\\${m[2]}`;
    else {
      log("Impossibile derivare il path locale remoto dall'UNC. Per --install");
      log("definisci PROD_REMOTE_PATH nel .env (es. C:\\fantaprod).");
      if (env.PROD_REMOTE_PATH) remoteLocalPath = env.PROD_REMOTE_PATH;
    }

    if (!remoteLocalPath) {
      console.error("ERRORE: path locale remoto non determinabile. Skip --install.");
    } else {
      const psScript = `
Set-Location -LiteralPath '${remoteLocalPath}'
Write-Host '== npm ci --omit=dev ==' -ForegroundColor Cyan
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm ci failed: $LASTEXITCODE" }
Write-Host '== npx prisma generate ==' -ForegroundColor Cyan
npx prisma generate
if ($LASTEXITCODE -ne 0) { throw "prisma generate failed: $LASTEXITCODE" }
`.trim();

      const psArgs = [
        "-NoProfile",
        "-Command",
        `Invoke-Command -ComputerName ${computerName} -ScriptBlock { ${psScript} }`,
      ];

      log(`powershell -NoProfile -Command "Invoke-Command -ComputerName ${computerName} ..."`);
      const psCode = await runStreaming("powershell", psArgs);
      if (psCode !== 0) {
        console.error(`\nERRORE: Invoke-Command è uscito con codice ${psCode}.`);
        console.error("Verifica che WinRM sia attivo su fantaserver:");
        console.error("  Enable-PSRemoting -Force   (eseguire come admin sul server)");
        process.exit(psCode);
      }
    }
  } else if (!DO_INSTALL) {
    log("Step 2 saltato (esegui a mano su fantaserver: `npm ci --omit=dev && npx prisma generate`).");
  } else {
    log("Step 2 saltato (dry-run).");
  }

  section("Sync completata");
  console.log(`
  Codice sincronizzato in: ${uncPath}
  ${DO_INSTALL && !DRY_RUN ? "Dipendenze installate e Prisma client rigenerato." : "Dipendenze NON aggiornate (lancia npm ci a mano sul server)."}
  Il file .env remoto NON è stato toccato (escluso dal sync).

  >>> RICORDA: riavvia manualmente il servizio su fantaserver.
`);
}

main().catch((err) => {
  console.error("\nERRORE durante il sync:", err.message);
  process.exit(1);
});
