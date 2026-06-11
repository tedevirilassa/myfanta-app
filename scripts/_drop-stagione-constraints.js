// Rimuove i vecchi vincoli/indici basati su stagione prima di prisma db push
// Uso: node scripts/_drop-stagione-constraints.js [--prod]
//   --prod  usa DATABASE_URL_PROD (fantaserver)
const { Pool } = require("pg");
const dns = require("dns");
require("dotenv").config();

const isProd = process.argv.includes("--prod");
if (isProd) dns.setDefaultResultOrder("ipv4first"); // fantaserver → forza IPv4

const connStr = isProd ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL;
if (!connStr) {
  console.error(isProd ? "DATABASE_URL_PROD mancante in .env" : "DATABASE_URL mancante in .env");
  process.exit(1);
}

console.log(`Connessione a: ${isProd ? "PROD" : "LOCAL"}`);
const pool = new Pool({ connectionString: connStr });

async function run() {
  const ddls = [
    `ALTER TABLE situazione_finanziaria DROP CONSTRAINT IF EXISTS "situazione_finanziaria_fantaTeamId_stagione_key"`,
    `ALTER TABLE rosa_giocatori DROP CONSTRAINT IF EXISTS "rosa_giocatori_fantaTeamId_giocatoreId_stagione_key"`,
    `ALTER TABLE proposte_rinnovo DROP CONSTRAINT IF EXISTS "proposte_rinnovo_fantaTeamId_stagione_ordinePriorita_key"`,
    `ALTER TABLE proposte_rinnovo DROP CONSTRAINT IF EXISTS "proposte_rinnovo_contrattoId_stagione_key"`,
    `DROP INDEX IF EXISTS "rosa_giocatori_fantaTeamId_giocatoreId_stagione_key"`,
    `DROP INDEX IF EXISTS "proposte_rinnovo_fantaTeamId_stagione_ordinePriorita_key"`,
  ];
  for (const ddl of ddls) {
    try {
      await pool.query(ddl);
      console.log("OK:", ddl.slice(0, 80));
    } catch (e) {
      console.warn("SKIP:", e.message.split("\n")[0]);
    }
  }
  await pool.end();
  console.log("Done.");
}

run().catch((e) => { console.error(e); process.exit(1); });
