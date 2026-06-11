"use strict";
// Verifica che Prisma restituisca MM-YYYY e scriva correttamente
require("dotenv").config();
const prisma = require("../src/lib/prisma");

async function main() {
  // Lettura: i campi devono tornare come MM-YYYY
  const sample = await prisma.contratto.findMany({
    take: 3,
    where: { valido: true },
    select: { id: true, dataStipula: true, dataFine: true },
  });
  console.log("Lettura da Prisma (devono essere MM-YYYY):");
  console.log(sample);

  // Verifica formato MM-YYYY
  for (const c of sample) {
    const okStipula = /^\d{2}-\d{4}$/.test(c.dataStipula);
    const okFine    = !c.dataFine || /^\d{2}-\d{4}$/.test(c.dataFine);
    console.log(`id=${c.id}  dataStipula="${c.dataStipula}" (${okStipula ? "✓" : "✗"})  dataFine="${c.dataFine}" (${okFine ? "✓" : "✗"})`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
