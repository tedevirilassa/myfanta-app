"use strict";
require("dotenv").config();
const net = require("net");
const { Client } = require("ssh2");
const { Pool } = require("pg");

const SSH_HOST = process.env.PROD_SSH_HOST || "fantaserver";
const SSH_USER = process.env.PROD_SSH_USER || "fantauser";
const SSH_PASS = process.env.PROD_SSH_PASSWORD;
const DB_URL_PROD = process.env.DATABASE_URL_PROD;
const PORT = 5457;

const conn = new Client();
const server = net.createServer((sock) => {
  conn.forwardOut("127.0.0.1", sock.localPort, "localhost", 5432, (err, ch) => {
    if (err) { sock.destroy(); return; }
    sock.pipe(ch); ch.pipe(sock);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  conn.on("ready", async () => {
    const u = new URL(DB_URL_PROD);
    u.hostname = "127.0.0.1"; u.port = String(PORT);
    const pool = new Pool({ connectionString: u.toString(), ssl: false });
    try {
      const res = await pool.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
        ["situazione_finanziaria"]
      );
      console.log("Colonne situazione_finanziaria su PROD:");
      res.rows.forEach(r => console.log(`  ${r.column_name}  (${r.data_type}, nullable=${r.is_nullable})`));

      const res3 = await pool.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1",
        ["trattative_mercato"]
      );
      console.log("\nColonne trattative_mercato su PROD:");
      res3.rows.forEach(r => console.log(`  ${r.column_name}  (${r.data_type})`));
    } finally {
      await pool.end(); conn.end(); server.close();
    }
  }).connect({ host: SSH_HOST, port: 22, username: SSH_USER, password: SSH_PASS });
});
