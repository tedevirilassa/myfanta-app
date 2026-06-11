require("dotenv").config();
const { Pool } = require("pg");
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROD });

async function run() {
  const client = await pool.connect();
  try {
    // Verifica quali valori esistono già
    const { rows } = await client.query(`
      SELECT enumlabel FROM pg_enum
      WHERE enumtypid = (
        SELECT oid FROM pg_type WHERE typname = 'CausaleFinanziaria'
      )`);
    const existing = new Set(rows.map(r => r.enumlabel));
    console.log("Valori enum esistenti:", [...existing]);

    if (!existing.has("PAGAMENTO_STIPENDIO_PLURIENNALE")) {
      await client.query(`ALTER TYPE "CausaleFinanziaria" ADD VALUE 'PAGAMENTO_STIPENDIO_PLURIENNALE'`);
      console.log("✓ PAGAMENTO_STIPENDIO_PLURIENNALE aggiunto");
    } else {
      console.log("⚠ PAGAMENTO_STIPENDIO_PLURIENNALE già presente, skip");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => { console.error("Errore:", e.message); process.exit(1); });
