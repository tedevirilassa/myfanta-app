
// src/testAppLoad.js
const app = require("./app");
console.log("App loaded OK. Routes:", app._router?.stack?.length);
