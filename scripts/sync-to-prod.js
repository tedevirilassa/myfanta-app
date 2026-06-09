/**
 * scripts/sync-to-prod.js
 *
 * Allinea il database locale (DEV) con quello di PROD su fantasserver
 * aprendo un tunnel SSH e sincronizzando tabella per tabella.
 *
 * Cosa fa:
 *   1. Apre un tunnel SSH locale  localhost:TUNNEL_PORT  →  localhost:DB_PORT  (sul server remoto)
 *   2. (opzionale) Applica le migration Prisma al DB PROD tramite il tunnel
 *   3. Copia tutti i dati dal DB locale al DB PROD tabella per tabella
 *   4. Riallinea le sequenze degli ID
 *   5. Chiude il tunnel
 *
 * Prerequisiti:
 *   - OpenSSH disponibile nel PATH (Windows 10+ / Linux / macOS)
 *   - Chiave SSH autorizzata su fantasserver (o SSH agent attivo)
 *   - DATABASE_URL_PROD già configurato in .env con le credenziali DB
 *
 * Variabili .env necessarie:
 *   DATABASE_URL_PROD=postgresql://user:pass@host:5432/dbname  ← già presente
 *   PROD_SSH_USER=ubuntu            # utente SSH (obbligatorio)
 *   PROD_SSH_HOST=fantasserver      # SSH host (default: host estratto da DATABASE_URL_PROD)
 *   PROD_SSH_PORT=22                # porta SSH (default: 22)
 *   PROD_SSH_KEY=~/.ssh/id_rsa      # chiave privata (opzionale, usa SSH agent se assente)
 *   PROD_DB_REMOTE_HOST=localhost   # host PostgreSQL SUL server remoto (default: localhost)
 *
 * Uso:
 *   node scripts/sync-to-prod.js              → solo dati
 *   node scripts/sync-to-prod.js --migrate    → migrate + dati
 *   node scripts/sync-to-prod.js --migrate-only → solo migrate
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawn, execSync } = require("child_process");
const { Pool } = require("pg");

// ─── Porta locale del tunnel SSH ─────────────────────────────────────────────

const TUNNEL_LOCAL_PORT = 5454;

// ─── Parsing env file ────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File non trovato: ${abs}`);
  }
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const result = {};
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
    result[key] = value;
  }
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[sync-prod] ${msg}`);
}

function logSection(title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function resolveTilde(p) {
  if (!p) return p;
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// ─── Tunnel SSH ──────────────────────────────────────────────────────────────

/**
 * Apre un tunnel SSH con port-forwarding locale.
 * Restituisce il processo SSH figlio da terminare alla fine.
 */
function startSshTunnel({ sshHost, sshPort, sshUser, sshKeyPath, remoteDbHost, remoteDbPort, localPort }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-N",                                                    // non eseguire comandi remoti
      "-L", `${localPort}:${remoteDbHost}:${remoteDbPort}`,   // port forwarding
      "-p", String(sshPort || 22),
      "-o", "StrictHostKeyChecking=accept-new",               // accetta nuovi host, rifiuta host cambiati
      "-o", "ExitOnForwardFailure=yes",                       // esci se il forward non riesce
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "BatchMode=yes",                                  // non chiedere password interattiva
    ];

    if (sshKeyPath) {
      args.push("-i", resolveTilde(sshKeyPath));
    }

    args.push(`${sshUser}@${sshHost}`);

    log(`Apertura tunnel SSH: ssh ${args.filter((a, i) => i > 0 || true).join(" ")}`);

    const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) log(`[SSH] ${msg}`);
    });

    proc.on("error", (err) => {
      reject(new Error(`Impossibile avviare SSH: ${err.message}\nVerifica che OpenSSH sia installato e nel PATH.`));
    });

    proc.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(`SSH terminato inaspettatamente con codice ${code}`));
      }
    });

    // Attendi che la porta locale risponda prima di procedere
    waitForPort(localPort, 20000)
      .then(() => {
        log(`Tunnel attivo su localhost:${localPort}`);
        resolve(proc);
      })
      .catch((err) => {
        proc.kill();
        reject(err);
      });
  });
}

/**
 * Attende che una porta TCP locale sia in ascolto.
 */
function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tryConnect = () => {
      const sock = new net.Socket();
      sock.setTimeout(600);

      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("timeout", () => {
        sock.destroy();
        retry();
      });
      sock.once("error", () => {
        sock.destroy();
        retry();
      });

      sock.connect(port, "127.0.0.1");
    };

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timeout: la porta ${port} non è diventata disponibile entro ${timeoutMs}ms.\nVerifica host/utente SSH e che PostgreSQL sia in esecuzione sul server remoto.`));
      } else {
        setTimeout(tryConnect, 600);
      }
    };

    tryConnect();
  });
}

// ─── Sincronizzazione tabelle ─────────────────────────────────────────────────

async function resetSequence(pool, table, idColumn = "id") {
  await pool.query(`
    SELECT setval(
      pg_get_serial_sequence('${table}', '${idColumn}'),
      COALESCE((SELECT MAX(${idColumn}) FROM ${table}), 0) + 1,
      false
    )
  `);
}

async function syncTable({ localPool, remotePool, table, columns, orderBy = "id" }) {
  log(`Lettura ${table} dal DB locale...`);
  const { rows } = await localPool.query(
    `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`
  );
  log(`  Trovate ${rows.length} righe`);

  if (rows.length === 0) {
    log(`  Tabella vuota, nessuna operazione.`);
    return;
  }

  log(`  Scrittura su PROD...`);
  const client = await remotePool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);

    for (const row of rows) {
      const values = columns.map((c) => row[c.replace(/^"|"$/g, "")]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      const cols = columns.join(", ");
      await client.query(
        `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`,
        values
      );
    }

    await client.query("COMMIT");
    log(`  OK – ${rows.length} righe sincronizzate`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Migrazione schema ────────────────────────────────────────────────────────

function runMigrations(tunnelDatabaseUrl) {
  logSection("Applicazione migration Prisma al DB PROD");
  log("Esecuzione: prisma migrate deploy");

  const env = { ...process.env, DATABASE_URL: tunnelDatabaseUrl };

  try {
    execSync("npx prisma migrate deploy", {
      env,
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
    log("Migration completate con successo.");
  } catch (err) {
    console.error("Errore durante le migration:", err.message);
    process.exit(1);
  }

  log("Esecuzione: prisma db push (allineamento schema completo)");
  try {
    execSync("npx prisma db push --accept-data-loss", {
      env,
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
    log("Schema PROD allineato con successo.");
  } catch (err) {
    console.error("Errore durante db push:", err.message);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const doMigrate = args.includes("--migrate") || args.includes("--migrate-only");
  const onlyMigrate = args.includes("--migrate-only");

  // ── Leggi configurazione da .env ──
  const localEnv = parseEnvFile(path.join(__dirname, "../.env"));

  const localUrl = localEnv.DATABASE_URL;
  if (!localUrl) throw new Error("DATABASE_URL mancante in .env");

  const remoteUrl = localEnv.DATABASE_URL_PROD;
  if (!remoteUrl) throw new Error("DATABASE_URL_PROD mancante in .env");

  // Estrai credenziali DB da DATABASE_URL_PROD
  let parsedUrl;
  try {
    parsedUrl = new URL(remoteUrl);
  } catch {
    throw new Error(`DATABASE_URL_PROD non è un URL PostgreSQL valido: ${remoteUrl}`);
  }

  const remoteDbPort = parseInt(parsedUrl.port || "5432", 10);
  const remoteDbName = parsedUrl.pathname.replace(/^\//, "").split("?")[0];
  const remoteDbUser = decodeURIComponent(parsedUrl.username);
  const remoteDbPassword = decodeURIComponent(parsedUrl.password);

  // Parametri SSH (PROD_SSH_HOST fallback all'hostname di DATABASE_URL_PROD)
  const sshHost = localEnv.PROD_SSH_HOST || parsedUrl.hostname;
  const sshPort = parseInt(localEnv.PROD_SSH_PORT || "22", 10);
  const sshUser = localEnv.PROD_SSH_USER;
  const sshKeyPath = localEnv.PROD_SSH_KEY || null;

  // Host PostgreSQL SUL server remoto (di solito localhost, ma sovrapponibile)
  const remoteDbHost = localEnv.PROD_DB_REMOTE_HOST || "localhost";

  // Validazione
  if (!sshUser) {
    console.error(
      "\nERRORE: PROD_SSH_USER mancante in .env\n" +
      "Aggiungi: PROD_SSH_USER=<utente-ssh-fantasserver>\n" +
      "Opzionali: PROD_SSH_HOST, PROD_SSH_PORT, PROD_SSH_KEY, PROD_DB_REMOTE_HOST\n"
    );
    process.exit(1);
  }

  // URL per il pool remoto e Prisma — punta al tunnel locale
  const encodedPassword = encodeURIComponent(remoteDbPassword);
  const tunnelDatabaseUrl =
    `postgresql://${encodeURIComponent(remoteDbUser)}:${encodedPassword}` +
    `@127.0.0.1:${TUNNEL_LOCAL_PORT}/${remoteDbName}`;

  // ── Apertura tunnel SSH ──
  logSection("Apertura tunnel SSH verso fantasserver");
  log(`SSH: ${sshUser}@${sshHost}:${sshPort}`);
  log(`Forward: localhost:${TUNNEL_LOCAL_PORT} → ${remoteDbHost}:${remoteDbPort} (remoto)`);

  let sshProcess = null;
  try {
    sshProcess = await startSshTunnel({
      sshHost,
      sshPort,
      sshUser,
      sshKeyPath,
      remoteDbHost,
      remoteDbPort,
      localPort: TUNNEL_LOCAL_PORT,
    });
  } catch (err) {
    console.error(`\nERRORE apertura tunnel SSH: ${err.message}\n`);
    process.exit(1);
  }

  // Funzione di cleanup
  const cleanup = () => {
    if (sshProcess && !sshProcess.killed) {
      log("Chiusura tunnel SSH...");
      sshProcess.kill();
    }
  };

  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    // ── Fase 1: migration ──
    if (doMigrate) {
      runMigrations(tunnelDatabaseUrl);
      if (onlyMigrate) {
        log("Fatto (solo migration).");
        cleanup();
        return;
      }
    }

    // ── Fase 2: sync dati ──
    logSection("Connessione ai database");

    const localPool = new Pool({ connectionString: localUrl });
    const remotePool = new Pool({ connectionString: tunnelDatabaseUrl });

    try {
      await localPool.query("SELECT 1");
      log("DB locale: connesso");
    } catch (e) {
      console.error("Impossibile connettersi al DB locale:", e.message);
      process.exit(1);
    }

    try {
      await remotePool.query("SELECT 1");
      log("DB PROD (via tunnel): connesso");
    } catch (e) {
      console.error("Impossibile connettersi al DB PROD tramite tunnel:", e.message);
      process.exit(1);
    }

    try {
      // ── fantapresidenti ──
      const { rows: existingUsers } = await remotePool.query(
        "SELECT COUNT(*) AS cnt FROM fantapresidenti"
      );
      if (parseInt(existingUsers[0].cnt, 10) > 0) {
        logSection("Tabella fantapresidenti: SALTATA (utenti già presenti nel DB PROD)");
      } else {
        logSection("Sync tabella: fantapresidenti (DB PROD vuoto → copia completa)");
        await syncTable({
          localPool, remotePool,
          table: "fantapresidenti",
          columns: [
            "id", "email", '"passwordHash"', "role", "nickname",
            '"createdAt"', '"updatedAt"',
          ],
        });
        await resetSequence(remotePool, "fantapresidenti");
      }

      // ── fanta_teams ──
      logSection("Sync tabella: fanta_teams");
      await syncTable({
        localPool, remotePool,
        table: "fanta_teams",
        columns: ["id", "nome", '"userId"', '"createdAt"', '"updatedAt"'],
      });
      await resetSequence(remotePool, "fanta_teams");

      // ── giocatori ──
      logSection("Sync tabella: giocatori");
      await syncTable({
        localPool, remotePool,
        table: "giocatori",
        columns: [
          "id", "nome", '"ruoloEsteso"', "ruolo", "squadra",
          "eta", '"anniContratto"', "valore", "active",
          '"createdAt"', '"updatedAt"',
        ],
      });
      await resetSequence(remotePool, "giocatori");

      // ── contratti ──
      logSection("Sync tabella: contratti");
      await syncTable({
        localPool, remotePool,
        table: "contratti",
        columns: [
          "id", "tipo", "clausola", '"dataStipula"', '"durataContratto"',
          '"dataFine"', '"giocatoreId"', '"fantaTeamId"',
          '"valoreGiocatore"', '"importoOperazione"', "provenienza", "destinazione",
          "valido", '"createdAt"', '"updatedAt"',
        ],
      });
      await resetSequence(remotePool, "contratti");

      // ── situazione_finanziaria ──
      logSection("Sync tabella: situazione_finanziaria");
      await syncTable({
        localPool, remotePool,
        table: "situazione_finanziaria",
        columns: [
          "id", '"nomePresidente"', "stagione", '"valoreRose"', "crediti",
          "patrimonio", '"giocatoriTesserati"', '"etaMedia"', "stipendi",
          '"montePrestiti"', '"ultimoPlusMinus"', '"fantaTeamId"',
          '"createdAt"', '"updatedAt"',
        ],
      });
      await resetSequence(remotePool, "situazione_finanziaria");

      // ── rosa_giocatori ──
      logSection("Sync tabella: rosa_giocatori");
      await syncTable({
        localPool, remotePool,
        table: "rosa_giocatori",
        columns: [
          '"id"', '"fantaTeamId"', '"giocatoreId"', '"stagione"',
          '"categoria"', '"createdAt"', '"updatedAt"',
        ],
      });
      await resetSequence(remotePool, "rosa_giocatori");

      // ── parametri ──
      logSection("Sync tabella: parametri");
      await syncTable({
        localPool, remotePool,
        table: "parametri",
        columns: [
          '"id"', '"chiave"', '"valore"', '"descrizione"',
          '"createdAt"', '"updatedAt"',
        ],
      });
      await resetSequence(remotePool, "parametri");

      // ── premi_erogati ──
      logSection("Sync tabella: premi_erogati");
      await syncTable({
        localPool, remotePool,
        table: "premi_erogati",
        columns: [
          '"id"', '"tipo"', '"stagione"', '"totale"',
          '"numBenef"', '"createdAt"', '"adminId"',
        ],
      });
      await resetSequence(remotePool, "premi_erogati");

      // ── trattative_mercato ──
      logSection("Sync tabella: trattative_mercato");
      await syncTable({
        localPool, remotePool,
        table: "trattative_mercato",
        columns: [
          '"id"', '"giocatoreId"', '"fantaTeamMittenteId"', '"fantaTeamRiceventeId"',
          '"importoOfferta"', '"valoreRiferimento"', '"stato"', '"motivoRifiuto"',
          '"dataDecorrenza"', '"createdAt"', '"updatedAt"', '"scadenzaAt"',
          '"contrattoNuovoId"',
        ],
      });
      await resetSequence(remotePool, "trattative_mercato");

      logSection("Sincronizzazione DEV → PROD completata con successo");
    } catch (err) {
      console.error("\nERRORE durante la sincronizzazione:", err.message);
      console.error(err.stack);
      process.exit(1);
    } finally {
      await localPool.end();
      await remotePool.end();
    }
  } finally {
    cleanup();
  }
}

main();

