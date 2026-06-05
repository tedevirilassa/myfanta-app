require("dotenv").config();
const prisma = require("../src/lib/prisma");
prisma.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  .then(r => console.log(r.map(x => x.tablename).join("\n")))
  .catch(e => console.error(e.message))
  .finally(() => prisma.$disconnect());
