"use strict";
require("dotenv").config();
const { Pool } = require("pg");
const bcrypt   = require("bcryptjs");
const pool     = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function main() {
  const { rows } = await pool.query(
    `SELECT email, "passwordHash", "mustChangePassword", "isActive" FROM fantapresidenti WHERE email = $1`,
    ["marco.piacitelli83@gmail.com"]
  );
  if (!rows.length) { console.log("Utente non trovato"); return; }
  const u = rows[0];
  console.log("isActive:", u.isActive, "mustChangePassword:", u.mustChangePassword);
  for (const pwd of ["Prova123", "Marco123", "prova123", "marco123"]) {
    const ok = await bcrypt.compare(pwd, u.passwordHash);
    console.log(`  '${pwd}': ${ok ? "✓ CORRETTA" : "✗"}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
