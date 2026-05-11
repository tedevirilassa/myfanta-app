"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const teams = await prisma.fantaTeam.findMany({ select: { id: true, nome: true } });
  for (const t of teams) {
    const contratti = await prisma.contratto.findMany({
      where: { fantaTeamId: t.id, valido: true },
      select: { id: true, durataContratto: true, dataFine: true, dataStipula: true, giocatore: { select: { nome: true, anniContratto: true } } },
      take: 5
    });
    console.log("\n--- " + t.nome + " (id=" + t.id + ") ---");
    contratti.forEach(c => {
      const mismatch = c.giocatore.anniContratto !== null && c.durataContratto !== c.giocatore.anniContratto ? " *** MISMATCH" : "";
      console.log(
        "  " + c.giocatore.nome.padEnd(25) +
        " durata=" + String(c.durataContratto).padStart(2) +
        "  g.anniContr=" + String(c.giocatore.anniContratto ?? "NULL").padStart(4) +
        "  stipula=" + (c.dataStipula || "NULL").padEnd(7) +
        "  fine=" + (c.dataFine || "NULL") +
        mismatch
      );
    });
  }

  await prisma.$disconnect();
  pool.end();
})();
