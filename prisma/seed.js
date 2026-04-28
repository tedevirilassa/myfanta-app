// prisma/seed.js
// Crea il primo utente ADMIN se non esiste già.
// Esegui con: node prisma/seed.js
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const bcrypt = require("bcryptjs");

const DEFAULT_PASSWORD = "primalogin2026";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "mrdownload@gmail.com";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

    if (existing) {
      console.log(`Admin già presente: ${ADMIN_EMAIL}`);
      return;
    }

    const hash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hash,
        role: "ADMIN",
        mustChangePassword: true,
      },
    });

    console.log(`✔ Admin creato: ${ADMIN_EMAIL}`);
    console.log(`  Password predefinita: ${DEFAULT_PASSWORD}`);
    console.log(`  L'utente dovrà cambiarla al primo accesso.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
