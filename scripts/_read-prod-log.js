"use strict";
require("dotenv").config();
const { Client } = require("ssh2");

const SSH_HOST = process.env.PROD_SSH_HOST || "fantaserver";
const SSH_PORT = parseInt(process.env.PROD_SSH_PORT || "22", 10);
const SSH_USER = process.env.PROD_SSH_USER || "fantauser";
const SSH_PASS = process.env.PROD_SSH_PASSWORD;
const REMOTE_PATH = "C:\\user\\fantauser\\fantaprod";

function execRemote(conn, cmd) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      let out = "";
      stream.on("data", (d) => { out += d; });
      stream.stderr.on("data", (d) => { out += d; });
      stream.on("close", () => res(out));
    });
  });
}

async function main() {
  const conn = new Client();
  await new Promise((res, rej) =>
    conn.on("ready", res).on("error", rej).connect({
      host: SSH_HOST, port: SSH_PORT, username: SSH_USER, password: SSH_PASS, readyTimeout: 20000,
    })
  );
  const nodeVer = await execRemote(conn, `node --version`);
  console.log("Node.js version:", nodeVer.trim());
  
  const pids = await execRemote(conn, `wmic process where "CommandLine like '%server.js%' and Name='node.exe'" get ProcessId /value`);
  console.log("PIDs node server.js:", pids.trim() || "(nessuno — server non in esecuzione)");
  conn.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
