require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  // Mostra utente 2
  const u = await prisma.user.findUnique({ where: { id: 2 }, select: { id: true, email: true, nickname: true } });
  console.log("User 2:", u);

  // Imposta nickname "Danilo" se non già presente
  if (u && u.nickname !== "Danilo") {
    await prisma.user.update({ where: { id: 2 }, data: { nickname: "Danilo" } });
    console.log("✅ Nickname aggiornato → Danilo");
  } else {
    console.log("ℹ️  Nickname già corretto.");
  }

  await prisma.$disconnect();
})();

