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

/**
 * Wrapper per logAction che produce un dettaglio standardizzato per il rollback.
 * @param {object} opts
 * @param {"INSERT"|"UPDATE"|"DELETE"} opts.tipo_operazione
 * @param {string}  opts.entita
 * @param {number}  [opts.entitaId]
 * @param {object|null} opts.stato_precedente - record PRIMA della mutazione (null per INSERT)
 * @param {object|null} opts.stato_successivo - record DOPO la mutazione (null per DELETE)
 * @param {number}  opts.adminId
 */
async function logMutation({ tipo_operazione, entita, entitaId, stato_precedente = null, stato_successivo = null, adminId }) {
  const azioneMap = { INSERT: "CREATE", UPDATE: "UPDATE", DELETE: "DELETE" };
  const azione = azioneMap[tipo_operazione] || tipo_operazione;
  await logAction({
    azione,
    entita,
    entitaId,
    dettaglio: { tipo_operazione, stato_precedente, stato_successivo },
    adminId,
  });
}

module.exports = { logAction, logMutation, runWithContext, getContext, sfRollbackSQL };

/**
 * Genera la query SQL per ripristinare una SituazioneFinanziaria allo stato
 * precedente a un'operazione. Usare i valori "prima" del log per il rollback.
 *
 * @param {number} sfId
 * @param {object} prima  - subset di { crediti, patrimonio, stipendi, valoreRose, giocatoriTesserati }
 * @returns {string|null}
 */
function sfRollbackSQL(sfId, prima) {
  if (!sfId || !prima) return null;
  const parts = [];
  if (prima.crediti            != null) parts.push(`"crediti" = ${Number(prima.crediti)}`);
  if (prima.patrimonio         != null) parts.push(`"patrimonio" = ${Number(prima.patrimonio)}`);
  if (prima.stipendi           != null) parts.push(`"stipendi" = ${Number(prima.stipendi)}`);
  if (prima.valoreRose         != null) parts.push(`"valoreRose" = ${Number(prima.valoreRose)}`);
  if (prima.giocatoriTesserati != null) parts.push(`"giocatoriTesserati" = ${Number(prima.giocatoriTesserati)}`);
  if (!parts.length) return null;
  return `UPDATE situazione_finanziaria SET ${parts.join(", ")} WHERE id = ${sfId};`;
}
