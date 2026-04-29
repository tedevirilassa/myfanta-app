"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const contratti = await prisma.contratto.findMany({ where: { dataFine: null } });
  console.log(`Contratti con dataFine null: ${contratti.length}`);
  let updated = 0;
  for (const c of contratti) {
    if (!c.dataStipula || !c.durataContratto) continue;
    const [mm, yyyy] = c.dataStipula.split("-");
    const dataFine = mm + "-" + (parseInt(yyyy) + parseInt(c.durataContratto));
    await prisma.contratto.update({ where: { id: c.id }, data: { dataFine } });
    console.log(`  id=${c.id}  dataStipula=${c.dataStipula}  durata=${c.durataContratto}  → dataFine=${dataFine}`);
    updated++;
  }
  console.log(`\nAggiornati: ${updated}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
