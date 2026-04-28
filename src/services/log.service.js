// src/services/log.service.js
// Scrive un record in log_azioni. Fire-and-forget: non blocca mai la risposta.

const prisma = require("../lib/prisma");

/**
 * @param {object} opts
 * @param {"CREATE"|"UPDATE"|"DELETE"} opts.azione
 * @param {string}  opts.entita      - es. "contratto", "utente", "giocatore"
 * @param {number}  [opts.entitaId]  - id della riga coinvolta
 * @param {object}  [opts.dettaglio] - oggetto libero, serializzato in JSON
 * @param {number}  opts.adminId     - id dell'utente che compie l'azione
 */
async function logAction({ azione, entita, entitaId = null, dettaglio = null, adminId }) {
  try {
    await prisma.log.create({
      data: {
        azione,
        entita,
        entitaId:  entitaId  ?? null,
        dettaglio: dettaglio ? JSON.stringify(dettaglio) : null,
        adminId,
      },
    });
  } catch (err) {
    // Il log non deve mai far crashare l'operazione principale
    console.error("[log.service] Errore scrittura log:", err.message);
  }
}

module.exports = { logAction };
