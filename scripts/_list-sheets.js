"use strict";
require("dotenv").config();
const https = require("https");

const SHEET_ID = process.env.SHEETS_ID || "1VQDWokZhWsj97ARkOQ-uAZVAUgNrlDC-xYdKnTxf9Zg";
const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;

https.get(url, (res) => {
  let d = "";
  res.on("data", (c) => (d += c));
  res.on("end", () => {
    const matches = d.match(/"name":"([^"]+)"/g) || [];
    matches.forEach((m) => console.log(m));
  });
}).on("error", (e) => console.error(e.message));
