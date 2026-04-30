"use strict";
require("dotenv").config();
const https = require("https");

const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";

function fetchCSV(sheetName) {
  return new Promise((resolve, reject) => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseCSV(text) {
  return text.split("\n").map((l) => parseCSVLine(l.replace(/\r$/, "")));
}

(async () => {
  const csv = await fetchCSV("riepilogoEx");
  const rows = parseCSV(csv);
  console.log("=== HEADER (riga 1) ===");
  console.log(rows[0]);
  console.log("\n=== TUTTE LE RIGHE DATI ===");
  for (let i = 1; i <= rows.length - 1; i++) {
    console.log(`Riga ${i + 1}:`, rows[i]);
  }
  console.log(`\nTotale righe (inclusa header): ${rows.length}`);
})();
