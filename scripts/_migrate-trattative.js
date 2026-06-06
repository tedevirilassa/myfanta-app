require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
CREATE TYPE "StatoTrattativa" AS ENUM ('PENDING','ACCEPTED','REJECTED','COMPLETED','EXPIRED');

CREATE TABLE trattative_mercato (
  id                    SERIAL PRIMARY KEY,
  "giocatoreId"         INTEGER NOT NULL REFERENCES giocatori(id),
  "fantaTeamMittenteId" INTEGER NOT NULL REFERENCES fanta_teams(id),
  "fantaTeamRiceventeId" INTEGER NOT NULL REFERENCES fanta_teams(id),
  "importoOfferta"      NUMERIC(10,2) NOT NULL,
  "valoreRiferimento"   NUMERIC(10,2) NOT NULL,
  stato                 "StatoTrattativa" NOT NULL DEFAULT 'PENDING',
  "motivoRifiuto"       TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scadenzaAt"          TIMESTAMP(3),
  "contrattoNuovoId"    INTEGER
);
`;

pool.query(sql)
  .then(() => { console.log("OK — trattative_mercato creata"); pool.end(); })
  .catch(e => { console.error("ERR:", e.message); pool.end(); process.exit(1); });
