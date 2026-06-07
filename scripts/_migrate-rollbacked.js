// One-shot: add rollbacked column to log_azioni
const { Client } = require('pg');

async function main() {
  const c = new Client('postgresql://fantauser:Prova123@localhost:5432/fantamanager');
  await c.connect();
  await c.query('ALTER TABLE log_azioni ADD COLUMN IF NOT EXISTS "rollbacked" BOOLEAN NOT NULL DEFAULT false');
  console.log('Migration applied: log_azioni.rollbacked column added');
  await c.end();
}

main().catch(e => { console.error(e); process.exit(1); });
