/**
 * scripts/sync-from-render.js
 *
 * Ribalta i dati dal database remoto (Render) al database locale.
 *
 * Cosa fa:
 *   1. Copia tutti i dati dal DB remoto al DB locale tabella per tabella
 *      (fantapresidenti → fanta_teams → giocatori → quotazioni → contratti → ...)
 *   2. Riallinea le sequenze degli ID
 *
 * Prerequisiti:
 *   - Compilare .envpublic con la stringa di connessione Render
 *   - Il DB remoto deve essere raggiungibile dalla tua macchina
 *
 * Uso:
 *   node scripts/sync-from-render.js              → copia tutto (chiede per fantapresidenti)
 *   node scripts/sync-from-render.js --force-users → sovrascrive fantapresidenti senza chiedere
 *   node scripts/sync-from-render.js --skip-users  → salta fantapresidenti senza chiedere
 *   node scripts/sync-from-render.js --dry-run     → mostra cosa farebbe senza scrivere
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Pool } = require("pg");

// ─── Prompt interattivo ─────────────────────────────────────────────────────

function askQuestion(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

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
  console.log(`[sync-from-render] ${msg}`);
}

function logSection(title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

async function resetSequence(pool, table, idColumn = "id") {
  await pool.query(`
    SELECT setval(
      pg_get_serial_sequence('${table}', '${idColumn}'),
      COALESCE((SELECT MAX(${idColumn}) FROM ${table}), 0) + 1,
      false
    )
  `);
}

// ─── Sync generica: remoto → locale ──────────────────────────────────────────

async function syncTable(opts) {
  const { localPool, remotePool, table, columns, orderBy = "id", dryRun = false } = opts;

  log(`Lettura ${table} dal remoto (Render)...`);
  const { rows } = await remotePool.query(
    `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`
  );
  log(`  Trovate ${rows.length} righe`);

  if (rows.length === 0) {
    log(`  Tabella vuota, nessuna operazione.`);
    return 0;
  }

  if (dryRun) {
    log(`  [DRY-RUN] Scriverei ${rows.length} righe nel locale`);
    return rows.length;
  }

  log(`  Scrittura sul DB locale...`);
  const client = await localPool.connect();
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
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun      = args.includes("--dry-run");
  const forceUsers  = args.includes("--force-users");
  const skipUsers   = args.includes("--skip-users");

  if (dryRun) {
    console.log("\n[DRY-RUN] Nessuna scrittura verrà effettuata\n");
  }

  const localEnv  = parseEnvFile(path.join(__dirname, "../.env"));
  const remoteEnv = parseEnvFile(path.join(__dirname, "../.envpublic"));

  const localUrl  = localEnv.DATABASE_URL;
  const remoteUrl = localEnv.DATABASE_URL_PROD || remoteEnv.DATABASE_URL;

  if (!localUrl)  throw new Error("DATABASE_URL mancante in .env");
  if (!remoteUrl) throw new Error("DATABASE_URL_PROD mancante in .env (o DATABASE_URL mancante in .envpublic)");

  if (remoteUrl.includes("USER:PASSWORD") || remoteUrl.includes("<HOST>")) {
    console.error(
      "\nERRORE: il DB remoto non è ancora stato configurato.\n" +
      "Imposta DATABASE_URL_PROD in .env oppure compila .envpublic.\n"
    );
    process.exit(1);
  }

  logSection("Connessione ai database");

  const localPool = new Pool({ connectionString: localUrl });
  const remotePool = new Pool({
    connectionString: remoteUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await localPool.query("SELECT 1");
    log("DB locale: connesso");
  } catch (e) {
    console.error("Impossibile connettersi al DB locale:", e.message);
    process.exit(1);
  }

  try {
    await remotePool.query("SELECT 1");
    log("DB remoto (Render): connesso");
  } catch (e) {
    console.error("Impossibile connettersi al DB remoto:", e.message);
    process.exit(1);
  }

  try {
    // ── fantapresidenti ──
    let syncUsers = forceUsers;
    if (!forceUsers && !skipUsers && !dryRun) {
      const { rows: existingUsers } = await localPool.query("SELECT COUNT(*) AS cnt FROM fantapresidenti");
      const countLocale = parseInt(existingUsers[0].cnt, 10);
      const hint = countLocale > 0
        ? `(attenzione: il DB locale contiene già ${countLocale} utenti → verranno sovrascritti)`
        : "(DB locale vuoto)";
      const answer = await askQuestion(
        `\nVuoi sovrascrivere fantapresidenti ${hint}? [s/N] `
      );
      syncUsers = answer === "s" || answer === "si" || answer === "y" || answer === "yes";
    }

    if (dryRun || !syncUsers) {
      if (dryRun) {
        logSection("Sync tabella: fantapresidenti (Render → locale) [DRY-RUN]");
        await syncTable({ localPool, remotePool, dryRun, table: "fantapresidenti",
          columns: ["id", "email", '"passwordHash"', "role", "nickname", '"createdAt"', '"updatedAt"'] });
      } else {
        logSection("Tabella fantapresidenti: SALTATA");
      }
    } else {
      logSection("Sync tabella: fantapresidenti");
      await syncTable({
        localPool, remotePool, dryRun,
        table: "fantapresidenti",
        columns: [
          "id", "email", '"passwordHash"', "role", "nickname",
          '"createdAt"', '"updatedAt"',
        ],
      });
      await resetSequence(localPool, "fantapresidenti");
    }

    // ── fanta_teams ──
    logSection("Sync tabella: fanta_teams (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "fanta_teams",
      columns: [
        "id", "nome", '"userId"', '"createdAt"', '"updatedAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "fanta_teams");

    // ── giocatori ──
    logSection("Sync tabella: giocatori (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "giocatori",
      columns: [
        "id", "nome", '"ruoloEsteso"', "ruolo", "squadra",
        "eta", '"anniContratto"', "valore", "active", '"createdAt"', '"updatedAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "giocatori");

    // ── quotazioni ──
    logSection("Sync tabella: quotazioni (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "quotazioni",
      columns: [
        "id", '"giocatoreId"', "valore", "fonte", '"createdAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "quotazioni");

    // ── contratti ──
    logSection("Sync tabella: contratti (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "contratti",
      columns: [
        "id", "tipo", "clausola", '"dataStipula"', '"durataContratto"',
        '"dataFine"', '"giocatoreId"', '"fantaTeamId"',
        '"valoreGiocatore"', '"importoOperazione"', "provenienza", "destinazione",
        "valido", '"prezzoAcquisto"', '"createdAt"', '"updatedAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "contratti");

    // ── situazione_finanziaria ──
    logSection("Sync tabella: situazione_finanziaria (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "situazione_finanziaria",
      columns: [
        "id", '"nomePresidente"', '"valoreRose"', "crediti",
        "patrimonio", '"giocatoriTesserati"', '"etaMedia"', "stipendi",
        '"montePrestiti"', '"ultimoPlusMinus"', '"fantaTeamId"',
        '"createdAt"', '"updatedAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "situazione_finanziaria");

    // ── rosa_giocatori ──
    logSection("Sync tabella: rosa_giocatori (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "rosa_giocatori",
      columns: [
        '"id"', '"fantaTeamId"', '"giocatoreId"',
        '"categoria"', '"createdAt"', '"updatedAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "rosa_giocatori");

    // ── parametri ──
    logSection("Sync tabella: parametri (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "parametri",
      columns: [
        '"id"', '"chiave"', '"valore"', '"descrizione"',
        '"createdAt"', '"updatedAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "parametri");

    // ── log_azioni (dal remoto, sovrascrive il locale) ──
    logSection("Sync tabella: log_azioni (Render → locale)");
    await syncTable({
      localPool, remotePool, dryRun,
      table: "log_azioni",
      columns: [
        "id", "azione", "entita", '"entitaId"', "dettaglio",
        '"adminId"', '"createdAt"',
      ],
    });
    if (!dryRun) await resetSequence(localPool, "log_azioni");

    logSection(dryRun
      ? "DRY-RUN completato — nessuna modifica effettuata"
      : "Sincronizzazione Render → locale completata con successo"
    );
  } catch (err) {
    console.error("\nERRORE durante la sincronizzazione:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await localPool.end();
    await remotePool.end();
  }
}

main();
