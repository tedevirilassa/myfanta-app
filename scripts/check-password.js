"use strict";
require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const fs = require("fs");

function parseEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, "utf8").split(/\r?\n/)
      .filter(l => l.includes("=") && !l.trim().startsWith("#"))
      .map(l => [l.split("=")[0].trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])
  );
}

async function check(label, url, ssl) {
  const pool = new Pool({ connectionString: url, ssl });
  try {
    const { rows } = await pool.query(
      'SELECT email, "passwordHash" FROM fantapresidenti WHERE email = $1',
      ["mrdownload@gmail.com"]
    );
    if (!rows.length) {
      console.log(label + ": utente NON trovato");
      return;
    }
    const valid = await bcrypt.compare("Prova123", rows[0].passwordHash);
    console.log(label + ": password 'Prova123' =>", valid ? "CORRETTA ✓" : "ERRATA ✗");
  } finally {
    await pool.end();
  }
}

const localEnv = parseEnv(".env");
const remoteEnv = parseEnv(".envpublic");

check("LOCALE", localEnv.DATABASE_URL, false)
  .then(() => check("RENDER", remoteEnv.DATABASE_URL, { rejectUnauthorized: false }))
  .catch(err => { console.error(err.message); process.exit(1); });
