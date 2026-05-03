"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const team = await prisma.fantaTeam.findFirst({ where: { nome: "Parkinglover" } });
  if (!team) { console.error("FantaTeam Parkinglover non trovato."); process.exit(1); }
  console.log(`FantaTeam trovato: id=${team.id} nome="${team.nome}"`);

  // Aggiorna SOLO i contratti con destinazione "N.A." (non sovrascrivere dati reali)
  const result = await prisma.contratto.updateMany({
    where: { fantaTeamId: team.id, destinazione: "N.A." },
    data: { destinazione: "Valentino" },
  });

  console.log(`Contratti aggiornati: ${result.count}`);

  // Mostra lista per verifica
  const lista = await prisma.contratto.findMany({
    where: { fantaTeamId: team.id },
    include: { giocatore: { select: { nome: true } } },
    orderBy: { id: "asc" },
  });
  lista.forEach(c => console.log(`  [${c.id}] ${c.giocatore.nome.padEnd(30)} dest: "${c.destinazione}"`));

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
