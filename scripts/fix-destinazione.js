"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TEAM_DEST = [
  { cerca: "Borsello", destinazione: "Giulio" },
  { cerca: "Feromoni", destinazione: "Capra"  },
  { cerca: "President", destinazione: "Danilo" },
];

async function main() {
  for (const { cerca, destinazione } of TEAM_DEST) {
    const team = await prisma.fantaTeam.findFirst({
      where: { nome: { contains: cerca, mode: "insensitive" } },
    });
    if (!team) { console.log(`[NON TROVATO] team con "${cerca}"`); continue; }
    const { count } = await prisma.contratto.updateMany({
      where: { fantaTeamId: team.id },
      data:  { destinazione },
    });
    console.log(`${team.nome} → destinazione="${destinazione}"  (${count} contratti aggiornati)`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
