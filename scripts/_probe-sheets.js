"use strict";
require("dotenv").config();
const https = require("https");

const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";

// Prova a scaricare diversi tab candidati per i team
const candidates = ["appo", "danilo", "Danilo", "presidente", "Presidente", "thepresident", "the president", "valentino", "Valentino", "giulio", "Giulio", "lorenzo", "Lorenzo", "paolo", "Paolo", "gabriele", "Gabriele", "capra", "Capra"];

async function trySheet(name) {
  return new Promise((resolve) => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
    https.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        const lines = d.split("\n").filter(Boolean);
        // Se il foglio non esiste restituisce errore o righe vuote
        const hasData = lines.length > 2 && !d.includes("Invalid query");
        resolve({ name, lines: lines.length, hasData, preview: lines[1] || "" });
      });
    }).on("error", () => resolve({ name, lines: 0, hasData: false, preview: "" }));
  });
}

(async () => {
  for (const c of candidates) {
    const r = await trySheet(c);
    if (r.hasData) console.log(`  [TROVATO] "${r.name}" - ${r.lines} righe - ${r.preview.slice(0, 80)}`);
    else console.log(`  [vuoto]   "${r.name}"`);
  }
})();
