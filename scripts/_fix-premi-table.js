require("dotenv").config();
const prisma = require("../src/lib/prisma");

async function main() {
  // Drop and recreate the table with proper enum type
  await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS premi_erogati");
  console.log("Dropped premi_erogati");

  // Create the enum type (if not exists)
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "TipoPremio" AS ENUM ('InizioStagione', 'Gennaio', 'Classifica');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);
  console.log("Created TipoPremio enum");

  // Recreate the table with proper enum column
  await prisma.$executeRawUnsafe(`
    CREATE TABLE premi_erogati (
      id SERIAL PRIMARY KEY,
      tipo "TipoPremio" NOT NULL,
      stagione TEXT NOT NULL,
      totale DECIMAL(10,2) NOT NULL,
      "numBenef" INTEGER NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "adminId" INTEGER NOT NULL,
      CONSTRAINT premi_erogati_tipo_stagione_key UNIQUE(tipo, stagione)
    )
  `);
  console.log("Created premi_erogati table with enum column");
}

main()
  .then(() => console.log("Done!"))
  .catch(e => console.error("ERR:", e.message))
  .finally(() => prisma.$disconnect());
