"use strict";
require("dotenv").config();
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const r = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name=$1",
    ["situazione_finanziaria"]
  );
  console.log("SF dev cols:", r.rows.map(x => x.column_name).join(", "));
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
