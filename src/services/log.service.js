// src/services/log.service.js
// Scrive un record in log_azioni. Fire-and-forget: non blocca mai la risposta.
//
// Supporta impersonificazione via AsyncLocalStorage: quando un admin
// impersona un altro utente, il middleware d'auth attiva un context con
// { impersonatorId, impersonator }; logAction lo legge e annida l'info nel
// dettaglio JSON come `impersonatedBy: { id, email, nickname }`. Tutti i
// call site esistenti restano invariati.

const { AsyncLocalStorage } = require("async_hooks");
const prisma = require("../lib/prisma");

const requestContext = new AsyncLocalStorage();

function runWithContext(ctx, fn) {
  return requestContext.run(ctx, fn);
}

function getContext() {
  return requestContext.getStore() || {};
}

/**
 * @param {object} opts
 * @param {"CREATE"|"UPDATE"|"DELETE"|"LOGIN"} opts.azione
 * @param {string}  opts.entita      - es. "contratto", "utente", "giocatore"
 * @param {number}  [opts.entitaId]  - id della riga coinvolta
 * @param {object}  [opts.dettaglio] - oggetto libero, serializzato in JSON
 * @param {number}  opts.adminId     - id dell'utente che compie l'azione (=
 *                                     l'utente impersonato in caso di impersonificazione)
 */
async function logAction({ azione, entita, entitaId = null, dettaglio = null, adminId }) {
  try {
    const ctx = getContext();
    let finalDettaglio = dettaglio;
    if (ctx.impersonatorId) {
      const tag = {
        id: ctx.impersonatorId,
        email: ctx.impersonator?.email || null,
        nickname: ctx.impersonator?.nickname || null,
      };
      if (finalDettaglio && typeof finalDettaglio === "object") {
        finalDettaglio = { ...finalDettaglio, impersonatedBy: tag };
      } else {
        finalDettaglio = { impersonatedBy: tag, raw: finalDettaglio };
      }
    }
    await prisma.log.create({
      data: {
        azione,
        entita,
        entitaId:  entitaId  ?? null,
        dettaglio: finalDettaglio ? JSON.stringify(finalDettaglio) : null,
        adminId,
      },
    });
  } catch (err) {
    // Il log non deve mai far crashare l'operazione principale
    console.error("[log.service] Errore scrittura log:", err.message);
  }
}

module.exports = { logAction, runWithContext, getContext };
