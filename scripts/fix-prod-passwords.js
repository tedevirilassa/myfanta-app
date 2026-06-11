/**
 * scripts/fix-prod-passwords.js
 *
 * Copia le passwordHash (e azzera mustChangePassword) dal DB locale
 * verso fantasserver, abbinando gli utenti per email.
 *
 * Strategia: genera un SQL con le UPDATE, lo invia via SSH pipe a psql
 * sul server remoto (evita tunneling e connessioni LAN dirette bloccate
 * da pg_hba.conf).
 *
 * Uso:
 *   node scripts/fix-prod-passwords.js
 *   node scripts/fix-prod-passwords.js --dry-run   ← mostra SQL senza eseguire
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { Pool } = require("pg");

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  if (isDryRun) console.log("[fix-pwd] DRY-RUN: nessuna scrittura su PROD\n");

  const env = parseEnvFile(path.join(__dirname, "../.env"));

  const localUrl = env.DATABASE_URL;
  if (!localUrl) throw new Error("DATABASE_URL mancante in .env");

  const remoteUrl = env.DATABASE_URL_PROD;
  if (!remoteUrl) throw new Error("DATABASE_URL_PROD mancante in .env");

  // Parametri SSH
  let parsedUrl;
  try { parsedUrl = new URL(remoteUrl); }
  catch { throw new Error(`DATABASE_URL_PROD non valido: ${remoteUrl}`); }

  const remoteDbPort   = parsedUrl.port || "5432";
  const remoteDbName   = parsedUrl.pathname.replace(/^\//, "").split("?")[0];
  const remoteDbUser   = decodeURIComponent(parsedUrl.username);
  const remoteDbPass   = decodeURIComponent(parsedUrl.password);
  const remoteDbHost   = env.PROD_DB_REMOTE_HOST || "localhost";

  const sshHost = env.PROD_SSH_HOST || parsedUrl.hostname;
  const sshPort = env.PROD_SSH_PORT || "22";
  const sshUser = env.PROD_SSH_USER;
  const sshKey  = env.PROD_SSH_KEY ? `-i ${env.PROD_SSH_KEY.replace("~", os.homedir())}` : "";

  if (!sshUser) throw new Error("PROD_SSH_USER mancante in .env");

  // ── Leggi utenti locali ──
  const localPool = new Pool({ connectionString: localUrl });
  let localUsers;
  try {
    const { rows } = await localPool.query(
      `SELECT id, email, "passwordHash", "isActive" FROM fantapresidenti ORDER BY id`
    );
    localUsers = rows;
  } finally {
    await localPool.end();
  }

  console.log(`\n[fix-pwd] Utenti nel DB locale: ${localUsers.length}`);
  console.table(localUsers.map(u => ({
    id: u.id,
    email: u.email,
    hash: u.passwordHash ? u.passwordHash.slice(0, 20) + "…" : "(vuoto)",
  })));

  // Filtra utenti senza hash
  const toUpdate = localUsers.filter(u => u.passwordHash);
  if (toUpdate.length === 0) throw new Error("Nessun utente con passwordHash nel DB locale.");

  // ── Genera SQL ──
  // Escape single-quote in bcrypt hash (non dovrebbero esserci, ma per sicurezza)
  const escapeSql = (s) => s.replace(/'/g, "''");

  const sqlLines = [
    "BEGIN;",
    ...toUpdate.map(u =>
      `UPDATE fantapresidenti SET "passwordHash"='${escapeSql(u.passwordHash)}', "mustChangePassword"=false, "isActive"=${u.isActive !== false} WHERE email='${escapeSql(u.email)}';`
    ),
    "COMMIT;",
    `SELECT id, email, LEFT("passwordHash",20) AS hash_preview, "mustChangePassword", "isActive" FROM fantapresidenti ORDER BY id;`,
  ];
  const sql = sqlLines.join("\n");

  console.log(`\n[fix-pwd] SQL generato (${toUpdate.length} UPDATE):`);
  sqlLines.slice(1, -2).forEach(l => console.log(" ", l.slice(0, 80) + (l.length > 80 ? "…" : "")));

  if (isDryRun) {
    console.log("\n[fix-pwd] DRY-RUN: SQL non inviato.");
    return;
  }

  // ── Invia via SSH a psql sul server remoto ──
  // PGPASSWORD passato come variabile d'ambiente nel comando remoto
  const sshCmd = [
    "ssh",
    "-p", sshPort,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    ...(sshKey ? sshKey.split(" ") : []),
    `${sshUser}@${sshHost}`,
    `PGPASSWORD='${escapeSql(remoteDbPass)}' psql -h ${remoteDbHost} -p ${remoteDbPort} -U ${remoteDbUser} -d ${remoteDbName}`,
  ].join(" ");

  console.log(`\n[fix-pwd] Invio SQL via SSH a ${sshUser}@${sshHost}...`);

  try {
    const output = execSync(sshCmd, {
      input: sql,
      encoding: "utf8",
      timeout: 30000,
    });
    console.log("\n[fix-pwd] Output PROD:\n" + output);
    console.log(`[fix-pwd] FATTO. ${toUpdate.length} utenti aggiornati su PROD.`);
  } catch (err) {
    console.error("[fix-pwd] Errore SSH/psql:", err.message);
    if (err.stdout) console.error("stdout:", err.stdout);
    if (err.stderr) console.error("stderr:", err.stderr);
    process.exit(1);
  }
}

main().catch(err => { console.error("\nERRORE:", err.message); process.exit(1); });
