require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE trattative_mercato
      ADD COLUMN IF NOT EXISTS "tipoContratto" TEXT NOT NULL DEFAULT 'Acquisto',
      ADD COLUMN IF NOT EXISTS clausola TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS "importoClausola" NUMERIC(10,2) DEFAULT NULL
  `);
  console.log('ALTER OK');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
