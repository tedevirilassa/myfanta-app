"use strict";
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

prisma.fantaTeam.findMany({ orderBy: { id: "asc" } }).then((teams) => {
  teams.forEach((t) => console.log(`id=${t.id}  nome="${t.nome}"  userId=${t.userId}`));
  return prisma.$disconnect();
});
