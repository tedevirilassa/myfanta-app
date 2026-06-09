/**
 * Utility centralizzata per il calcolo degli anni residui di un contratto.
 *
 * REGOLA DI BUSINESS (vedi project.md / linee guida):
 * - Per i contratti con scadenza a Luglio, durante il mese di Giugno
 *   l'anno residuo deve essere mostrato come 0 se la scadenza coincide
 *   con l'anno solare corrente (per permettere la gestione anticipata
 *   dei rinnovi prima della scadenza effettiva).
 *
 * Ogni calcolo "anni residui" nell'app DEVE passare da qui.
 */

/**
 * Converte un input flessibile (Date | "MM-YYYY" | ISO string) in Date.
 * Restituisce null se il valore non è interpretabile.
 */
function parseExpiry(expiryDate) {
  if (!expiryDate) return null;
  if (expiryDate instanceof Date) {
    return isNaN(expiryDate.getTime()) ? null : expiryDate;
  }
  if (typeof expiryDate === "string") {
    // Formato applicativo standard: "MM-YYYY"
    const m = /^(\d{2})-(\d{4})$/.exec(expiryDate);
    if (m) {
      const mm = parseInt(m[1], 10);
      const yyyy = parseInt(m[2], 10);
      if (mm >= 1 && mm <= 12) return new Date(yyyy, mm - 1, 1);
      return null;
    }
    const d = new Date(expiryDate);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Calcola gli anni residui di un contratto applicando la "Regola di Giugno".
 *
 * @param {Date|string} expiryDate Data di scadenza (Date, "MM-YYYY" o ISO)
 * @param {Date} [today] Riferimento "oggi" (override per i test)
 * @returns {number|null} Anni residui (>= 0); null se input non valido.
 */
function getRemainingContractYears(expiryDate, today = new Date()) {
  const dataScadenza = parseExpiry(expiryDate);
  if (!dataScadenza) return null;

  const annoOggi = today.getFullYear();
  const meseOggi = today.getMonth();          // 0 = Gennaio, 5 = Giugno

  const annoScadenza = dataScadenza.getFullYear();
  const meseScadenza = dataScadenza.getMonth(); // 6 = Luglio

  // Regola di Giugno
  if (annoOggi === annoScadenza && meseOggi === 5) {
    return 0;
  }

  let anni = annoScadenza - annoOggi;

  // Se il mese corrente è oltre la scadenza, l'anno è già "consumato"
  if (meseOggi > meseScadenza) {
    anni -= 1;
  }

  return anni < 0 ? 0 : anni;
}

module.exports = {
  getRemainingContractYears,
};
