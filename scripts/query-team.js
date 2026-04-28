require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const team = await prisma.fantaTeam.findFirst({
    where: { nome: { contains: "president", mode: "insensitive" } },
    include: {
      contratti: {
        include: { giocatore: true },
      },
    },
  });

  if (!team) {
    console.log("Nessun team trovato con 'president' nel nome.");
    const all = await prisma.fantaTeam.findMany({ select: { id: true, nome: true } });
    console.log("Team disponibili:", all);
    await prisma.$disconnect();
    return;
  }

  console.log(`\nTeam: ${team.nome} (id: ${team.id})`);
  console.log(`Contratti totali: ${team.contratti.length}\n`);

  const attivi = team.contratti.filter((c) => !c.dataFine);
  const scaduti = team.contratti.filter((c) => c.dataFine);

  console.log("=== CONTRATTI ATTIVI ===");
  attivi.forEach((c) => {
    const g = c.giocatore;
    console.log(
      `  [${g.ruolo}] ${g.nome.padEnd(25)} ${(g.squadra || "?").padEnd(20)} stipula: ${c.dataStipula}  durata: ${c.durataContratto}y  importo: ${c.importoOperazione ?? "-"}`
    );
  });

  if (scaduti.length) {
    console.log("\n=== CONTRATTI CON DATA FINE ===");
    scaduti.forEach((c) => {
      const g = c.giocatore;
      console.log(`  [${g.ruolo}] ${g.nome.padEnd(25)} fine: ${c.dataFine}`);
    });
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
