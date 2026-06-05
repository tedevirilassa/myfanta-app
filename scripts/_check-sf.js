require("dotenv").config();
const prisma = require("../src/lib/prisma");

prisma.situazioneFinanziaria.findMany({
  where: { stagione: "2025-2026" },
  select: { id: true, nomePresidente: true, fantaTeamId: true },
})
  .then(rows => {
    console.log(`Found ${rows.length} SF records for 2025-2026:`);
    rows.forEach(r => console.log(`  id=${r.id} presidente="${r.nomePresidente}" fantaTeamId=${r.fantaTeamId}`));
  })
  .catch(e => console.error("ERR:", e.message))
  .finally(() => prisma.$disconnect());
