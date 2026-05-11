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
 *   node scripts/sync-from-render.js
 *   node scripts/sync-from-render.js --dry-run   → mostra cosa farebbe senza scrivere
 */

"use strict";

const fs = require("fs");
const path = require("path");
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
  const dryRun = args.includes("--dry-run");

  if (dryRun) {
    console.log("\n🔍 MODALITÀ DRY-RUN: nessuna scrittura verrà effettuata\n");
  }

  const localEnv = parseEnvFile(path.join(__dirname, "../.env"));
  const remoteEnv = parseEnvFile(path.join(__dirname, "../.envpublic"));

  const localUrl = localEnv.DATABASE_URL;
  const remoteUrl = remoteEnv.DATABASE_URL;

  if (!localUrl) throw new Error("DATABASE_URL mancante in .env");
  if (!remoteUrl) throw new Error("DATABASE_URL mancante in .envpublic");

  if (remoteUrl.includes("USER:PASSWORD") || remoteUrl.includes("HOST")) {
    console.error(
      "\nERRORE: .envpublic non è ancora stato configurato.\n" +
        "Sostituisci USER, PASSWORD, HOST, DBNAME con i valori reali da Render.\n"
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
    // ── fantapresidenti (self-ref: invitedById) ──
    logSection("Sync tabella: fantapresidenti (Render → locale)");

    log("Lettura fantapresidenti dal remoto...");
    const { rows: users } = await remotePool.query(
      `SELECT id, email, "passwordHash", role, "isActive", "mustChangePassword",
              nickname, "invitedById", "createdAt", "updatedAt"
       FROM fantapresidenti ORDER BY id`
    );
    log(`  Trovate ${users.length} righe`);

    if (!dryRun && users.length > 0) {
      const client = await localPool.connect();
      try {
        await client.query("BEGIN");

        // Salva i log locali prima del TRUNCATE CASCADE
        const { rows: savedLogs } = await client.query(
          `SELECT * FROM log_azioni ORDER BY id`
        );
        if (savedLogs.length > 0) {
          log(`  💾 Salvati ${savedLogs.length} record di log_azioni (verranno ripristinati)`);
        }

        await client.query(`TRUNCATE TABLE fantapresidenti RESTART IDENTITY CASCADE`);

        // Prima passata: inserisci senza invitedById
        for (const u of users) {
          await client.query(
            `INSERT INTO fantapresidenti
               (id, email, "passwordHash", role, "isActive", "mustChangePassword",
                nickname, "invitedById", "createdAt", "updatedAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)`,
            [
              u.id, u.email, u.passwordHash, u.role, u.isActive,
              u.mustChangePassword, u.nickname,
              u.createdAt, u.updatedAt,
            ]
          );
        }

        // Seconda passata: aggiorna invitedById
        for (const u of users) {
          if (u.invitedById !== null) {
            await client.query(
              `UPDATE fantapresidenti SET "invitedById" = $1 WHERE id = $2`,
              [u.invitedById, u.id]
            );
          }
        }

        // Ripristina i log locali salvati
        if (savedLogs.length > 0) {
          for (const l of savedLogs) {
            await client.query(
              `INSERT INTO log_azioni (id, azione, entita, "entitaId", dettaglio, "adminId", "createdAt")
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [l.id, l.azione, l.entita, l.entitaId, l.dettaglio, l.adminId, l.createdAt]
            );
          }
          log(`  ✅ Ripristinati ${savedLogs.length} record di log_azioni`);
        }

        await client.query("COMMIT");
        log(`  OK – ${users.length} righe sincronizzate`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await resetSequence(localPool, "fantapresidenti");
      await resetSequence(localPool, "log_azioni");
    } else if (dryRun) {
      log(`  [DRY-RUN] Scriverei ${users.length} utenti nel locale`);
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
        "id", '"giocatoreId"', "valore", "fonte", "stagione", '"createdAt"',
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
        "id", '"nomePresidente"', "stagione", '"valoreRose"', "crediti",
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
        '"id"', '"fantaTeamId"', '"giocatoreId"', '"stagione"',
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
