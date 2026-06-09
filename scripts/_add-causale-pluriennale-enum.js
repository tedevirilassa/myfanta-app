// scripts/_add-causale-pluriennale-enum.js
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    await pool.query(`ALTER TYPE "CausaleFinanziaria" ADD VALUE IF NOT EXISTS 'PAGAMENTO_STIPENDIO_PLURIENNALE' BEFORE 'STORNO_STIPENDIO_P2P'`);
    const r = await pool.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CausaleFinanziaria') ORDER BY enumsortorder`);
    console.log('CausaleFinanziaria valori attuali:', r.rows.map(x => x.enumlabel).join(', '));
  } catch (e) { console.error(e); process.exit(1); }
  finally { await pool.end(); }
})();
