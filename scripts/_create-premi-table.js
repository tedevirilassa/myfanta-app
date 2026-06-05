require("dotenv").config();
const prisma = require("../src/lib/prisma");

const sql = `
CREATE TABLE IF NOT EXISTS premi_erogati (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,
  stagione TEXT NOT NULL,
  totale DECIMAL(10,2) NOT NULL,
  "numBenef" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "adminId" INTEGER NOT NULL,
  CONSTRAINT premi_erogati_tipo_stagione_key UNIQUE(tipo, stagione)
)`;

prisma.$executeRawUnsafe(sql)
  .then(() => console.log("OK: premi_erogati table created"))
  .catch(e => console.error("ERR:", e.message))
  .finally(() => prisma.$disconnect());
