/**
 * scripts/sync-to-render.js
 *
 * Allinea il database locale con quello remoto su Render.
 *
 * Cosa fa:
 *   1. Applica le migration Prisma al DB remoto (prisma migrate deploy)
 *   2. Copia tutti i dati dal DB locale al DB remoto tabella per tabella
 *      (fanta_teams → giocatori → contratti)
 *      NOTA: la tabella fantapresidenti NON viene sincronizzata
 *      per preservare utenti e password sul DB remoto.
 *   3. Riallinea le sequenze degli ID
 *
 * Prerequisiti:
 *   - Compila .envpublic con la stringa di connessione Render
 *   - Il DB remoto deve essere raggiungibile dalla tua macchina
 *
 * Uso:
 *   node scripts/sync-to-render.js            → solo dati
 *   node scripts/sync-to-render.js --migrate  → migrate + dati
 *   node scripts/sync-to-render.js --migrate-only → solo migrate
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Pool } = require("pg");

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
    // rimuove virgolette
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
  console.log(`[sync] ${msg}`);
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

// ─── Sincronizzazione dati ────────────────────────────────────────────────────

async function syncTable(opts) {
  const { localPool, remotePool, table, columns, orderBy = "id" } = opts;

  log(`Lettura ${table} dal locale...`);
  const { rows } = await localPool.query(
    `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`
  );
  log(`  Trovate ${rows.length} righe`);

  if (rows.length === 0) {
    log(`  Tabella vuota, nessuna operazione.`);
    return;
  }

  log(`  Scrittura su Render...`);
  const client = await remotePool.connect();
  try {
    await client.query("BEGIN");

    // Svuota la tabella remota (CASCADE per rispettare le FK)
    await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);

    // Inserimento batch
    for (const row of rows) {
      // Le colonne con virgolette (es. '"createdAt"') vanno strippate per accedere
      // alla proprietà dell'oggetto restituito da pg (es. 'createdAt')
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

function runMigrations(remoteUrl) {
  logSection("Applicazione migration Prisma al DB remoto");
  log("Esecuzione: prisma migrate deploy");

  const env = {
    ...process.env,
    DATABASE_URL: remoteUrl,
  };

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

  // Applica anche eventuali tabelle/colonne presenti nello schema ma non ancora
  // nelle migration (create localmente via prisma db push senza file .sql).
  log("Esecuzione: prisma db push (allineamento schema completo)");
  try {
    execSync("npx prisma db push --accept-data-loss", {
      env,
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
    log("Schema remoto allineato con successo.");
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

  // Leggi le due configurazioni
  const localEnv  = parseEnvFile(path.join(__dirname, "../.env"));
  const remoteEnv = parseEnvFile(path.join(__dirname, "../.envpublic"));

  const localUrl = localEnv.DATABASE_URL;
  // DATABASE_URL_PROD in .env ha priorità su DATABASE_URL di .envpublic
  const remoteUrl = localEnv.DATABASE_URL_PROD || remoteEnv.DATABASE_URL;

  if (!localUrl)  throw new Error("DATABASE_URL mancante in .env");
  if (!remoteUrl) throw new Error("DATABASE_URL_PROD mancante in .env (o DATABASE_URL mancante in .envpublic)");

  // Verifica che il DB remoto non sia un placeholder non configurato
  if (remoteUrl.includes("USER:PASSWORD") || remoteUrl.includes("<HOST>")) {
    console.error(
      "\nERRORE: il DB remoto non è ancora stato configurato.\n" +
        "Imposta DATABASE_URL_PROD in .env oppure compila .envpublic.\n"
    );
    process.exit(1);
  }

  // ── Fase 1: migration ──
  if (doMigrate) {
    runMigrations(remoteUrl);
    if (onlyMigrate) {
      log("Fatto (solo migration).");
      return;
    }
  }

  // ── Fase 2: sync dati ──
  logSection("Connessione ai database");

  const localPool = new Pool({ connectionString: localUrl });
  // SSL solo se richiesto dall'URL (es. Render); per server LAN locali si disabilita
  const remoteNeedsSsl = remoteUrl.includes("sslmode=require") || remoteUrl.includes("render.com");
  const remotePool = new Pool({
    connectionString: remoteUrl,
    ...(remoteNeedsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // Verifica connessioni
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
    // Se il DB remoto ha già utenti, li preserviamo (comportamento Render legacy).
    // Su un DB nuovo/vuoto copiamo tutto.
    const { rows: existingUsers } = await remotePool.query("SELECT COUNT(*) AS cnt FROM fantapresidenti");
    if (parseInt(existingUsers[0].cnt, 10) > 0) {
      logSection("Tabella fantapresidenti: SALTATA (utenti già presenti nel DB remoto)");
    } else {
      logSection("Sync tabella: fantapresidenti (DB remoto vuoto → copia completa)");
      await syncTable({
        localPool,
        remotePool,
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
      localPool,
      remotePool,
      table: "fanta_teams",
      columns: [
        "id", "nome", '"userId"', '"createdAt"', '"updatedAt"',
      ],
    });
    await resetSequence(remotePool, "fanta_teams");

    // ── giocatori ──
    logSection("Sync tabella: giocatori");
    await syncTable({
      localPool,
      remotePool,
      table: "giocatori",
      columns: [
        "id", "nome", '"ruoloEsteso"', "ruolo", "squadra",
        "eta", '"anniContratto"', "valore", "active", '"createdAt"', '"updatedAt"',
      ],
    });
    await resetSequence(remotePool, "giocatori");

    // ── contratti ──
    logSection("Sync tabella: contratti");
    await syncTable({
      localPool,
      remotePool,
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
      localPool,
      remotePool,
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

    // ── movimenti_finanziari ──
    // Richiede che CausaleFinanziaria + tabella esistano già su remote
    // (eseguire `scripts/_apply-movimenti-finanziari-ddl.js` puntato a Render
    // o `npx prisma db push` con DATABASE_URL=Render una tantum).
    logSection("Sync tabella: movimenti_finanziari");
    await syncTable({
      localPool, remotePool,
      table: "movimenti_finanziari",
      columns: [
        '"id"', '"fantaTeamId"', '"sfId"', '"stagione"',
        '"importo"', '"causale"', '"contesto"', '"logId"', '"createdAt"',
      ],
    });
    await resetSequence(remotePool, "movimenti_finanziari");

    logSection("Sincronizzazione completata con successo");
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
