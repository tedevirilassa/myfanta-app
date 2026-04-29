"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const contratti = await prisma.contratto.findMany({
    where: { id: { in: [25, 178, 181, 183, 155, 156] } },
  });
  console.log(`Contratti da aggiornare: ${contratti.length}`);
  let updated = 0;
  for (const c of contratti) {
    const stipendio = Math.round(parseFloat(c.valoreGiocatore) * 0.05 * 100) / 100;
    await prisma.contratto.update({ where: { id: c.id }, data: { importoOperazione: stipendio } });
    console.log(`  id=${c.id}  valore=${c.valoreGiocatore}  → stipendio=${stipendio}`);
    updated++;
  }
  console.log(`\nAggiornati: ${updated}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
