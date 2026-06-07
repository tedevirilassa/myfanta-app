require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

prisma.fantaTeam.findMany({ select: { id: true, nome: true } })
  .then(t => { console.log(JSON.stringify(t, null, 2)); return prisma.$disconnect(); })
  .catch(e => { console.error(e); process.exit(1); });
