require("dotenv").config();
const prisma = require("../src/lib/prisma");

prisma.$queryRawUnsafe("SELECT typname FROM pg_type WHERE typname ILIKE '%premio%' OR typname ILIKE '%tipo%'")
  .then(r => console.log("Types:", r))
  .catch(e => console.error("ERR:", e.message))
  .finally(() => prisma.$disconnect());
