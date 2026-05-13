// Sanitizzazione input testo dal client.
// In particolare: la stringa letterale "null" o "undefined" arriva talvolta dal client
// (es. binding template che stampa null come testo). Va trattata come valore assente.

function cleanNickname(input, maxLen = 40) {
  const v = (input || "").trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "null" || lower === "undefined") return null;
  return v.slice(0, maxLen);
}

module.exports = { cleanNickname };
