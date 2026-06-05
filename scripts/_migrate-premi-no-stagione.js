require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query(`
  ALTER TABLE premi_erogati ALTER COLUMN stagione DROP NOT NULL;
  ALTER TABLE premi_erogati DROP CONSTRAINT IF EXISTS premi_erogati_tipo_stagione_key;
`)
  .then(() => { console.log("OK"); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
