/**
 * scripts/pull-fantapresidenti.js
 *
 * Copia in locale SOLO la tabella `fantapresidenti` dal DB remoto (Render).
 *
 * Strategia: UPSERT per id (INSERT ... ON CONFLICT DO UPDATE), in due passate
 * per gestire la self-reference invitedById. NON tronca la tabella, quindi
 * NON viene effettuato CASCADE su fanta_teams / log_azioni / premi_erogati.
 *
 * Uso:
 *   node scripts/pull-fantapresidenti.js
 *   node scripts/pull-fantapresidenti.js --dry-run
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function parseEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File non trovato: ${abs}`);
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function log(msg)         { console.log(`[pull-fantapresidenti] ${msg}`); }
function logSection(t)    { console.log(`\n${"═".repeat(60)}\n  ${t}\n${"═".repeat(60)}`); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  if (dryRun) console.log("\n🔍 MODALITÀ DRY-RUN: nessuna scrittura verrà effettuata\n");

  const localEnv  = parseEnvFile(path.join(__dirname, "../.env"));
  const remoteEnv = parseEnvFile(path.join(__dirname, "../.envpublic"));

  if (!localEnv.DATABASE_URL)  throw new Error("DATABASE_URL mancante in .env");
  if (!remoteEnv.DATABASE_URL) throw new Error("DATABASE_URL mancante in .envpublic");
  if (remoteEnv.DATABASE_URL.includes("USER:PASSWORD")) {
    console.error("ERRORE: .envpublic non configurato.");
    process.exit(1);
  }

  logSection("Connessione ai database");
  const localPool  = new Pool({ connectionString: localEnv.DATABASE_URL });
  const remotePool = new Pool({ connectionString: remoteEnv.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try { await localPool.query("SELECT 1");  log("DB locale: connesso"); }
  catch (e) { console.error("Locale KO:", e.message); process.exit(1); }
  try { await remotePool.query("SELECT 1"); log("DB remoto: connesso"); }
  catch (e) { console.error("Remoto KO:", e.message); process.exit(1); }

  try {
    logSection("Lettura fantapresidenti da Render");
    const { rows: users } = await remotePool.query(`
      SELECT id, email, "passwordHash", role, "isActive", "mustChangePassword",
             nickname, "invitedById", "createdAt", "updatedAt"
      FROM fantapresidenti ORDER BY id
    `);
    log(`Trovate ${users.length} righe remote`);

    if (dryRun) {
      log("[DRY-RUN] mostrerei UPSERT per:");
      for (const u of users) console.log(`  id=${u.id}  ${u.email}  nickname=${u.nickname}`);
      return;
    }

    if (users.length === 0) { log("Nessuna riga da copiare."); return; }

    logSection("UPSERT su DB locale (passata 1: invitedById = NULL)");
    const client = await localPool.connect();
    try {
      await client.query("BEGIN");
      for (const u of users) {
        await client.query(`
          INSERT INTO fantapresidenti
            (id, email, "passwordHash", role, "isActive", "mustChangePassword",
             nickname, "invitedById", "createdAt", "updatedAt")
          VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)
          ON CONFLICT (id) DO UPDATE SET
            email              = EXCLUDED.email,
            "passwordHash"     = EXCLUDED."passwordHash",
            role               = EXCLUDED.role,
            "isActive"         = EXCLUDED."isActive",
            "mustChangePassword" = EXCLUDED."mustChangePassword",
            nickname           = EXCLUDED.nickname,
            "invitedById"      = NULL,
            "createdAt"        = EXCLUDED."createdAt",
            "updatedAt"        = EXCLUDED."updatedAt"
        `, [u.id, u.email, u.passwordHash, u.role, u.isActive,
            u.mustChangePassword, u.nickname, u.createdAt, u.updatedAt]);
      }

      log("Passata 2: aggiorno invitedById…");
      for (const u of users) {
        if (u.invitedById !== null) {
          await client.query(
            `UPDATE fantapresidenti SET "invitedById" = $1 WHERE id = $2`,
            [u.invitedById, u.id]
          );
        }
      }

      await client.query("COMMIT");
      log(`OK – ${users.length} righe upserted`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Riallinea la sequenza per evitare conflitti sui prossimi insert
    await localPool.query(`
      SELECT setval(
        pg_get_serial_sequence('fantapresidenti', 'id'),
        COALESCE((SELECT MAX(id) FROM fantapresidenti), 0) + 1,
        false
      )
    `);
    log("Sequenza id riallineata");

    logSection("Pull fantapresidenti completato");
  } catch (err) {
    console.error("\nERRORE:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await localPool.end();
    await remotePool.end();
  }
}

main();
