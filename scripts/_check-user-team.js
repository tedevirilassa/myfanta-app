require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  const [teams, users] = await Promise.all([
    prisma.fantaTeam.findMany({ select: { id: true, nome: true, userId: true } }),
    prisma.user.findMany({ select: { id: true, email: true, nickname: true } }),
  ]);
  console.log('TEAMS:', JSON.stringify(teams, null, 2));
  console.log('USERS:', JSON.stringify(users, null, 2));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
