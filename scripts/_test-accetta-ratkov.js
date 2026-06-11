"use strict";
/**
 * Simula: login come Marco (Como Supersonics) + accettazione offerta trattativa id=1 (Ratkov)
 * Cattura e stampa l'errore esatto.
 */
const http = require("http");

const BASE = "http://localhost:3000";

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // ── 1. Login come Marco (Como Supersonics) ─────────────────────────────────
  const loginBody = JSON.stringify({ email: "marco.piacitelli83@gmail.com", password: "Marco123" });
  const loginRes = await request({
    hostname: "localhost", port: 3000,
    path: "/auth/login", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(loginBody) },
  }, loginBody);

  console.log("LOGIN status:", loginRes.status);
  console.log("LOGIN body:", loginRes.body.slice(0, 300));

  const cookie = loginRes.headers["set-cookie"]?.[0]?.split(";")[0];
  if (!cookie) {
    // Prova con form POST
    const formBody = `email=marco.piacitelli83%40gmail.com&password=Marco123`;
    const loginRes2 = await request({
      hostname: "localhost", port: 3000,
      path: "/auth/login", method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formBody),
      },
    }, formBody);
    console.log("LOGIN2 status:", loginRes2.status);
    const cookie2 = loginRes2.headers["set-cookie"]?.[0]?.split(";")[0];
    console.log("Cookie:", cookie2);

    if (!cookie2) {
      console.error("Login fallito, impossibile ottenere cookie");
      return;
    }
    await accettaOfferta(cookie2);
    return;
  }
  console.log("Cookie:", cookie);
  await accettaOfferta(cookie);
}

async function accettaOfferta(cookie) {
  // ── 2. Accetta offerta id=1 ─────────────────────────────────────────────────
  const body = JSON.stringify({ azione: "ACCEPT" });
  const res = await request({
    hostname: "localhost", port: 3000,
    path: "/mercato/offerta/1/risposta", method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cookie": cookie,
    },
  }, body);

  console.log("\n=== PATCH /mercato/offerta/1/risposta ===");
  console.log("Status:", res.status);
  try {
    console.log("Body:", JSON.stringify(JSON.parse(res.body), null, 2));
  } catch {
    console.log("Body (raw):", res.body.slice(0, 500));
  }
}

main().catch(console.error);
