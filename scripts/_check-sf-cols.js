require("dotenv").config();
const prisma = require("../src/lib/prisma");

async function main() {
  const sf = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'situazione_finanziaria' ORDER BY ordinal_position`;
  console.log("\n=== situazione_finanziaria ===");
  sf.forEach(x => console.log(" ", x.column_name));

  const mv = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'movimenti_finanziari' ORDER BY ordinal_position`;
  console.log("\n=== movimenti_finanziari ===");
  mv.forEach(x => console.log(" ", x.column_name));
}

main().catch(console.error).finally(() => prisma.$disconnect());
