// src/services/finanze.service.js
// Helper centralizzato per movimentare crediti/stipendi sulla SituazioneFinanziaria.
// Ogni movimento è tracciato in `MovimentoFinanziario` e in `Log` con pre/post,
// così da consentire rollback puntuale.
//
// USO TIPICO (dentro una $transaction Prisma):
//
//   await modificaCreditiTeam(tx, {
//     fantaTeamId,
//     stagione: "2026-2027",
//     deltaCrediti:  -ingaggio,
//     deltaStipendi: +ingaggio,
//     causale: "PAGAMENTO_STIPENDIO_RINNOVO",
//     contesto: { contrattoId, giocatoreNome },
//     adminId,
//     checkCapienza: true,
//   });
//
// Throw `InsufficientCreditiError` se `checkCapienza && nuovoSaldo < 0`.

const CAUSALI = Object.freeze({
  PAGAMENTO_STIPENDIO_RINNOVO:     "PAGAMENTO_STIPENDIO_RINNOVO",
  PAGAMENTO_STIPENDIO_P2P:         "PAGAMENTO_STIPENDIO_P2P",
  PAGAMENTO_STIPENDIO_PLURIENNALE: "PAGAMENTO_STIPENDIO_PLURIENNALE",
  STORNO_STIPENDIO_P2P:            "STORNO_STIPENDIO_P2P",
  ALTRO:                           "ALTRO",
});

class InsufficientCreditiError extends Error {
  constructor(saldoPre, deltaCrediti) {
    super(`Crediti insufficienti: saldo ${saldoPre.toFixed(2)} M, delta ${deltaCrediti.toFixed(2)} M (richiesti ${Math.abs(deltaCrediti).toFixed(2)} M).`);
    this.name = "InsufficientCreditiError";
    this.saldoPre = saldoPre;
    this.deltaCrediti = deltaCrediti;
  }
}

function r2(n) { return Math.round(n * 100) / 100; }

async function _findSF(tx, { sfId, fantaTeamId, stagione }) {
  if (sfId) return tx.situazioneFinanziaria.findUnique({ where: { id: sfId } });
  return tx.situazioneFinanziaria.findFirst({
    where: { fantaTeamId, stagione },
  });
}

/**
 * Applica un movimento finanziario su SF + scrive Log + MovimentoFinanziario.
 *
 * @param {PrismaClient|TransactionClient} tx
 * @param {object} opts
 * @param {number}   [opts.sfId]                  alternativa a (fantaTeamId,stagione)
 * @param {number}   opts.fantaTeamId
 * @param {string}   opts.stagione
 * @param {number}   opts.deltaCrediti            segno: <0 addebito, >0 accredito
 * @param {number}   [opts.deltaStipendi=0]       segno: <0 storno, >0 nuovo carico
 * @param {keyof CAUSALI} opts.causale
 * @param {object}   [opts.contesto]              JSON libero: contrattoId, giocatoreNome, ...
 * @param {number}   opts.adminId
 * @param {boolean}  [opts.checkCapienza=true]    se true e deltaCrediti<0 e saldoPost<0 → throw
 * @param {string}   [opts.azioneLog="UPDATE"]
 * @returns {Promise<{ movimento, log, sf, pre, post }>}
 */
async function modificaCreditiTeam(tx, opts) {
  const {
    sfId, fantaTeamId, stagione,
    deltaCrediti = 0,
    deltaStipendi = 0,
    causale,
    contesto = null,
    adminId,
    checkCapienza = true,
    azioneLog = "UPDATE",
  } = opts;

  if (!CAUSALI[causale]) {
    throw new Error(`Causale non valida: ${causale}. Usa una di: ${Object.keys(CAUSALI).join(", ")}.`);
  }
  if (!Number.isFinite(deltaCrediti) || !Number.isFinite(deltaStipendi)) {
    throw new Error(`Delta non finiti: crediti=${deltaCrediti}, stipendi=${deltaStipendi}.`);
  }
  if (!adminId) throw new Error("adminId obbligatorio per modificaCreditiTeam.");

  const sf = await _findSF(tx, { sfId, fantaTeamId, stagione });
  if (!sf) {
    throw new Error(`SituazioneFinanziaria non trovata (sfId=${sfId} fantaTeamId=${fantaTeamId} stagione=${stagione}).`);
  }

  const pre = {
    crediti:    Number(sf.crediti),
    stipendi:   Number(sf.stipendi),
    patrimonio: Number(sf.patrimonio),
  };
  const post = {
    crediti:    r2(pre.crediti + deltaCrediti),
    stipendi:   r2(pre.stipendi + deltaStipendi),
    patrimonio: r2(pre.patrimonio + deltaCrediti), // patrimonio = crediti + valoreRose; varia come crediti
  };

  if (checkCapienza && deltaCrediti < 0 && post.crediti < 0) {
    throw new InsufficientCreditiError(pre.crediti, deltaCrediti);
  }

  await tx.situazioneFinanziaria.update({
    where: { id: sf.id },
    data:  { crediti: post.crediti, stipendi: post.stipendi, patrimonio: post.patrimonio },
  });

  const dettaglio = {
    tipo: "movimento-finanziario",
    causale,
    sfId: sf.id,
    fantaTeamId: sf.fantaTeamId,
    stagione: sf.stagione,
    deltaCrediti, deltaStipendi,
    pre, post,
    contesto: contesto || null,
  };
  const log = await tx.log.create({
    data: {
      azione: azioneLog,
      entita: "movimento_finanziario",
      entitaId: null,
      dettaglio: JSON.stringify(dettaglio),
      adminId,
    },
  });

  const movimento = await tx.movimentoFinanziario.create({
    data: {
      fantaTeamId: sf.fantaTeamId,
      sfId: sf.id,
      stagione: sf.stagione,
      importo: deltaCrediti, // segno reale del movimento di crediti
      causale,
      contesto: contesto ? JSON.stringify(contesto) : null,
      logId: log.id,
    },
  });

  return { movimento, log, sf, pre, post };
}

module.exports = {
  modificaCreditiTeam,
  CAUSALI,
  InsufficientCreditiError,
};
