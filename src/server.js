
// src/server.js
require("dotenv").config();

const app = require("./app");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

const server = app.listen(PORT, () => {
  console.log(`✅ [pid=${process.pid}] Server avviato: http://${HOST}:${PORT}`, JSON.stringify(server.address()));
});

server.on("close", () => console.log(`⚠️  [pid=${process.pid}] server CLOSED`));

server.on("error", (err) => {
  console.error(`❌ [pid=${process.pid}] Server error: ${err.code}`, err.message);
  process.exit(1);
});

process.on("exit", (code) => console.log(`🚪 [pid=${process.pid}] exit code=${code}`));
