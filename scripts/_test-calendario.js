// scripts/_test-calendario.js — test del controller calendario-azioni
"use strict";
require("dotenv/config");
const prisma = require("../src/lib/prisma");
const parametriService = require("../src/services/parametri.service");

async function main() {
  console.log("1. Loading params...");
  const params = await parametriService.getAll();
  console.log("   params keys:", Object.keys(params).length);
  console.log("   stagione_inizio:", params.stagione_inizio);

  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const now = new Date();
  const annoInizio = now.getMonth() + 1 >= meseInizio ? now.getFullYear() : now.getFullYear() - 1;
  const stagione = `${annoInizio}-${annoInizio + 1}`;
  console.log("   stagione:", stagione);

  console.log("2. Querying premioErogato InizioStagione...");
  const p1 = await prisma.premioErogato.findFirst({ where: { tipo: "InizioStagione", stagione } });
  console.log("   result:", p1);

  console.log("3. Querying premioErogato Gennaio...");
  const p2 = await prisma.premioErogato.findFirst({ where: { tipo: "Gennaio", stagione } });
  console.log("   result:", p2);

  console.log("4. Querying propostaRinnovo count...");
  const p3 = await prisma.propostaRinnovo.count({ where: { status: "PENDING", stagione } });
  console.log("   result:", p3);

  console.log("5. Querying contratto count...");
  const p4 = await prisma.contratto.count({ where: { valido: true } });
  console.log("   result:", p4);

  console.log("6. Querying quotazione findFirst...");
  const p5 = await prisma.quotazione.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  console.log("   result:", p5);

  console.log("\nAll queries OK!");
}

main()
  .catch(err => { console.error("FAILED:", err.message, err.stack); })
  .finally(() => prisma.$disconnect());
