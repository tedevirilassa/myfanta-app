"use strict";
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({ connectionString: "postgresql://fantauser:Prova123@localhost:5432/fantamanager" });

pool.query('SELECT email, "passwordHash", "isActive" FROM fantapresidenti ORDER BY id')
  .then(r => {
    const lines = ["BEGIN;"];
    for (const u of r.rows) {
      const hash  = u.passwordHash.replace(/'/g, "''");
      const email = u.email.replace(/'/g, "''");
      lines.push(`UPDATE fantapresidenti SET "passwordHash"='${hash}', "mustChangePassword"=false, "isActive"=${u.isActive !== false} WHERE email='${email}';`);
    }
    lines.push("COMMIT;");
    lines.push(`SELECT id, email, LEFT("passwordHash",20) AS hash_preview, "mustChangePassword", "isActive" FROM fantapresidenti ORDER BY id;`);

    const sql = lines.join("\n");
    const outFile = path.join(__dirname, "../scripts/_fix-passwords.sql");
    fs.writeFileSync(outFile, sql, "utf8");
    console.log(`SQL scritto in scripts/_fix-passwords.sql (${r.rows.length} utenti)`);
    lines.slice(1, -2).forEach(l => console.log("  " + l.slice(0, 100)));
  })
  .catch(e => { console.error("ERRORE:", e.message); })
  .finally(() => pool.end());
