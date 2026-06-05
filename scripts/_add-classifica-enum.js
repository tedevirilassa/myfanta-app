require("dotenv").config();
const prisma = require("../src/lib/prisma");

prisma.$executeRawUnsafe("ALTER TYPE \"TipoPremio\" ADD VALUE IF NOT EXISTS 'Classifica'")
  .then(() => console.log("OK: Classifica added to TipoPremio enum"))
  .catch(e => console.error("ERR:", e.message))
  .finally(() => prisma.$disconnect());
