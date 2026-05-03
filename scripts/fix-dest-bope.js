"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const team = await prisma.fantaTeam.findFirst({ where: { nome: "Bope El Burro" } });
  if (!team) { console.error("FantaTeam Bope El Burro non trovato."); process.exit(1); }
  console.log(`FantaTeam trovato: id=${team.id} nome="${team.nome}"`);

  const result = await prisma.contratto.updateMany({
    where: { fantaTeamId: team.id, NOT: { destinazione: "Andrea" } },
    data: { destinazione: "Andrea" },
  });

  console.log(`Contratti aggiornati: ${result.count}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
