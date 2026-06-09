/**
 * scripts/_apply-movimenti-finanziari-ddl.js
 * Applica direttamente DDL per CausaleFinanziaria + movimenti_finanziari
 * senza passare da `prisma migrate` (il DB è in drift).
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DDL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CausaleFinanziaria') THEN
    CREATE TYPE "CausaleFinanziaria" AS ENUM (
      'PAGAMENTO_STIPENDIO_RINNOVO',
      'PAGAMENTO_STIPENDIO_P2P',
      'STORNO_STIPENDIO_P2P',
      'ALTRO'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "movimenti_finanziari" (
  "id"          SERIAL PRIMARY KEY,
  "fantaTeamId" INTEGER NOT NULL,
  "sfId"        INTEGER NOT NULL,
  "stagione"    TEXT NOT NULL,
  "importo"     DECIMAL(10,2) NOT NULL,
  "causale"     "CausaleFinanziaria" NOT NULL,
  "contesto"    TEXT,
  "logId"       INTEGER,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "movimenti_finanziari_fantaTeamId_stagione_idx"
  ON "movimenti_finanziari" ("fantaTeamId", "stagione");

CREATE INDEX IF NOT EXISTS "movimenti_finanziari_causale_idx"
  ON "movimenti_finanziari" ("causale");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'movimenti_finanziari_logId_fkey'
  ) THEN
    ALTER TABLE "movimenti_finanziari"
      ADD CONSTRAINT "movimenti_finanziari_logId_fkey"
      FOREIGN KEY ("logId") REFERENCES "log_azioni"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
`;

(async () => {
  try {
    await pool.query(DDL);
    console.log('[ddl] movimenti_finanziari + CausaleFinanziaria applicati.');
    const { rows } = await pool.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'movimenti_finanziari'
      ORDER BY ordinal_position`);
    console.table(rows);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
