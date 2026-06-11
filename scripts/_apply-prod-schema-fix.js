/**
 * scripts/_apply-prod-schema-fix.js
 *
 * Applica le modifiche di schema post-migration al DB di PROD (fantasserver).
 * Da eseguire una volta dopo `npm run prod:deploy-install`.
 *
 * Usa DATABASE_URL_PROD dal .env.
 *
 * Cambiamenti applicati (tutti idempotenti con IF EXISTS / IF NOT EXISTS):
 *   1. situazione_finanziaria  — rimuove colonna stagione + vecchi constraint → aggiunge nuovi unique
 *   2. rosa_giocatori          — rimuove colonna stagione + deduplica → aggiunge unique(fantaTeamId, giocatoreId)
 *   3. proposte_rinnovo        — rimuove colonna stagione + vecchi index → aggiunge unique(fantaTeamId, ordinePriorita)
 *   4. log_azioni              — aggiunge colonna rollbacked
 *   5. CausaleFinanziaria enum + tabella movimenti_finanziari (senza stagione)
 *   6. PAGAMENTO_STIPENDIO_PLURIENNALE aggiunto all'enum se mancante
 */

"use strict";
require("dotenv").config();
const dns = require("dns");
const { Pool } = require("pg");

dns.setDefaultResultOrder("ipv4first"); // forza IPv4 per fantasserver

const connStr = process.env.DATABASE_URL_PROD;
if (!connStr) {
  console.error("DATABASE_URL_PROD mancante in .env");
  process.exit(1);
}

const pool = new Pool({ connectionString: connStr });

const STEPS = [
  // ── 1. situazione_finanziaria ─────────────────────────────────────────────
  {
    label: "SF: drop constraint nomePresidente_stagione_key",
    sql: `ALTER TABLE situazione_finanziaria DROP CONSTRAINT IF EXISTS "situazione_finanziaria_nomePresidente_stagione_key"`,
  },
  {
    label: "SF: drop constraint fantaTeamId_stagione_key",
    sql: `ALTER TABLE situazione_finanziaria DROP CONSTRAINT IF EXISTS "situazione_finanziaria_fantaTeamId_stagione_key"`,
  },
  {
    label: "SF: drop column stagione",
    sql: `ALTER TABLE situazione_finanziaria DROP COLUMN IF EXISTS stagione`,
  },
  {
    label: "SF: add unique nomePresidente",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'situazione_finanziaria_nomePresidente_key'
            AND conrelid = 'situazione_finanziaria'::regclass
        ) THEN
          ALTER TABLE situazione_finanziaria
            ADD CONSTRAINT "situazione_finanziaria_nomePresidente_key"
            UNIQUE ("nomePresidente");
        END IF;
      END $$`,
  },
  {
    label: "SF: add unique fantaTeamId",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'situazione_finanziaria_fantaTeamId_key'
            AND conrelid = 'situazione_finanziaria'::regclass
        ) THEN
          ALTER TABLE situazione_finanziaria
            ADD CONSTRAINT "situazione_finanziaria_fantaTeamId_key"
            UNIQUE ("fantaTeamId");
        END IF;
      END $$`,
  },

  // ── 2. rosa_giocatori ─────────────────────────────────────────────────────
  {
    label: "ROSA: drop unique index stagione",
    sql: `DROP INDEX IF EXISTS "rosa_giocatori_fantaTeamId_giocatoreId_stagione_key"`,
  },
  {
    label: "ROSA: deduplica per (fantaTeamId, giocatoreId) — mantiene riga con id MAX",
    sql: `
      DELETE FROM rosa_giocatori rg
      WHERE rg.id NOT IN (
        SELECT MAX(id)
        FROM rosa_giocatori
        GROUP BY "fantaTeamId", "giocatoreId"
      )`,
  },
  {
    label: "ROSA: drop column stagione",
    sql: `ALTER TABLE rosa_giocatori DROP COLUMN IF EXISTS stagione`,
  },
  {
    label: "ROSA: add unique (fantaTeamId, giocatoreId)",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'rosa_giocatori_fantaTeamId_giocatoreId_key'
            AND conrelid = 'rosa_giocatori'::regclass
        ) THEN
          ALTER TABLE rosa_giocatori
            ADD CONSTRAINT "rosa_giocatori_fantaTeamId_giocatoreId_key"
            UNIQUE ("fantaTeamId", "giocatoreId");
        END IF;
      END $$`,
  },

  // ── 3. proposte_rinnovo ───────────────────────────────────────────────────
  {
    label: "PR: drop unique index stagione",
    sql: `DROP INDEX IF EXISTS "proposte_rinnovo_team_stagione_priorita_key"`,
  },
  {
    label: "PR: drop constraint stagione (if named differently)",
    sql: `ALTER TABLE proposte_rinnovo DROP CONSTRAINT IF EXISTS "proposte_rinnovo_fantaTeamId_stagione_ordinePriorita_key"`,
  },
  {
    label: "PR: drop constraint contrattoId_stagione",
    sql: `ALTER TABLE proposte_rinnovo DROP CONSTRAINT IF EXISTS "proposte_rinnovo_contrattoId_stagione_key"`,
  },
  {
    label: "PR: drop column stagione",
    sql: `ALTER TABLE proposte_rinnovo DROP COLUMN IF EXISTS stagione`,
  },
  {
    label: "PR: add unique (fantaTeamId, ordinePriorita)",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'proposte_rinnovo_fantaTeamId_ordinePriorita_key'
            AND conrelid = 'proposte_rinnovo'::regclass
        ) THEN
          ALTER TABLE proposte_rinnovo
            ADD CONSTRAINT "proposte_rinnovo_fantaTeamId_ordinePriorita_key"
            UNIQUE ("fantaTeamId", "ordinePriorita");
        END IF;
      END $$`,
  },
  {
    label: "PR: index (fantaTeamId, ordinePriorita)",
    sql: `CREATE INDEX IF NOT EXISTS "proposte_rinnovo_fantaTeamId_ordinePriorita_idx" ON proposte_rinnovo ("fantaTeamId", "ordinePriorita")`,
  },

  // ── 4. log_azioni: rollbacked ─────────────────────────────────────────────
  {
    label: "LOG: add column rollbacked",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'log_azioni' AND column_name = 'rollbacked'
        ) THEN
          ALTER TABLE log_azioni ADD COLUMN rollbacked BOOLEAN NOT NULL DEFAULT false;
        END IF;
      END $$`,
  },

  // ── 5. CausaleFinanziaria enum ────────────────────────────────────────────
  {
    label: "ENUM: create CausaleFinanziaria",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CausaleFinanziaria') THEN
          CREATE TYPE "CausaleFinanziaria" AS ENUM (
            'PAGAMENTO_STIPENDIO_RINNOVO',
            'PAGAMENTO_STIPENDIO_P2P',
            'STORNO_STIPENDIO_P2P',
            'ALTRO'
          );
        END IF;
      END $$`,
  },
  {
    label: "ENUM: add PAGAMENTO_STIPENDIO_PLURIENNALE",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = 'CausaleFinanziaria'::regtype
            AND enumlabel = 'PAGAMENTO_STIPENDIO_PLURIENNALE'
        ) THEN
          ALTER TYPE "CausaleFinanziaria" ADD VALUE 'PAGAMENTO_STIPENDIO_PLURIENNALE';
        END IF;
      END $$`,
  },

  // ── 6. movimenti_finanziari ───────────────────────────────────────────────
  {
    label: "MF: create table movimenti_finanziari (senza stagione)",
    sql: `
      CREATE TABLE IF NOT EXISTS "movimenti_finanziari" (
        "id"          SERIAL PRIMARY KEY,
        "fantaTeamId" INTEGER NOT NULL,
        "sfId"        INTEGER NOT NULL,
        "importo"     DECIMAL(10,2) NOT NULL,
        "causale"     "CausaleFinanziaria" NOT NULL,
        "contesto"    TEXT,
        "logId"       INTEGER,
        "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
  },
  {
    label: "MF: drop stagione column if exists (creata da script vecchio)",
    sql: `ALTER TABLE movimenti_finanziari DROP COLUMN IF EXISTS stagione`,
  },
  {
    label: "MF: drop old index stagione if exists",
    sql: `DROP INDEX IF EXISTS "movimenti_finanziari_fantaTeamId_stagione_idx"`,
  },
  {
    label: "MF: index (fantaTeamId)",
    sql: `CREATE INDEX IF NOT EXISTS "movimenti_finanziari_fantaTeamId_idx" ON movimenti_finanziari ("fantaTeamId")`,
  },
  {
    label: "MF: index (causale)",
    sql: `CREATE INDEX IF NOT EXISTS "movimenti_finanziari_causale_idx" ON movimenti_finanziari ("causale")`,
  },
  {
    label: "MF: FK logId → log_azioni",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'movimenti_finanziari_logId_fkey'
        ) THEN
          ALTER TABLE "movimenti_finanziari"
            ADD CONSTRAINT "movimenti_finanziari_logId_fkey"
            FOREIGN KEY ("logId") REFERENCES "log_azioni"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
      END $$`,
  },
];

async function run() {
  const client = await pool.connect();
  try {
    let ok = 0; let skip = 0;
    for (const step of STEPS) {
      try {
        await client.query(step.sql);
        console.log(`  ✓  ${step.label}`);
        ok++;
      } catch (e) {
        console.warn(`  ⚠  ${step.label}: ${e.message.split("\n")[0]}`);
        skip++;
      }
    }
    console.log(`\nCompletato: ${ok} OK, ${skip} warning (già applicati o non necessari).`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
