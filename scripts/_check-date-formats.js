"use strict";
require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query(`
  SELECT
    (SELECT COUNT(*) FROM contratti WHERE "dataStipula" IS NOT NULL) AS contratti_stipula,
    (SELECT COUNT(*) FROM contratti WHERE "dataFine" IS NOT NULL) AS contratti_fine,
    (SELECT COUNT(*) FROM giocatori WHERE "dataNascita" IS NOT NULL) AS giocatori_nascita,
    (SELECT "dataStipula" FROM contratti WHERE "dataStipula" IS NOT NULL LIMIT 1) AS esempio_stipula,
    (SELECT "dataFine"    FROM contratti WHERE "dataFine"    IS NOT NULL LIMIT 1) AS esempio_fine,
    (SELECT "dataNascita" FROM giocatori  WHERE "dataNascita" IS NOT NULL LIMIT 1) AS esempio_nascita,
    (SELECT "dataDecorrenza" FROM trattative_mercato WHERE "dataDecorrenza" IS NOT NULL LIMIT 1) AS esempio_decorrenza
`).then(r => {
  console.log(r.rows[0]);
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
