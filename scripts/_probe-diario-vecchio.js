"use strict";
require("dotenv").config();
const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";

function parseCSVLine(line) {
  const result = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

const TARGETS = [
  "mike maignan","rafael leao","paulo dybala","davide frattesi",
  "federico dimarco","romelu lukaku","nicolo rovella","christian pulisic"
];

function norm(s) { return (s||"").trim().toLowerCase().replace(/\s+/g," "); }

async function main() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=DiarioVecchio`;
  const res = await fetch(url);
  if (!res.ok) { console.error("HTTP", res.status); process.exit(1); }
  const text = await res.text();
  const lines = text.split("\n");

  // Intestazione
  console.log("=== Prime 5 righe ===");
  lines.slice(0, 5).forEach((l, i) => {
    const cols = parseCSVLine(l.replace(/\r$/,""));
    console.log(`Row ${i}:`, cols.map((c,j)=>`[${j}]"${c}"`).join("  "));
  });

  console.log("\n=== Cerca target nel foglio ===");
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i].replace(/\r$/,""));
    const nome = norm(cols[0]);
    if (TARGETS.includes(nome)) {
      console.log(`Riga ${i}: nome="${cols[0]}" col2="${cols[2]}" col3="${cols[3]}" col4="${cols[4]}"`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
