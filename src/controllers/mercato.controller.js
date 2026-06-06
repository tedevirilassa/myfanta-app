// src/controllers/mercato.controller.js
// Trattative di mercato P2P tra fanta-presidenti.
// Flusso: invio offerta → accetta/rifiuta → finalizza trasferimento (transazione ACID).

const prisma = require("../lib/prisma");
const { logAction, sfRollbackSQL } = require("../services/log.service");
const { sendEmailToUser } = require("../services/email.service");
const parametriService = require("../services/parametri.service");

// ── Costanti ──────────────────────────────────────────────────────────────────
const OFFERTA_DELTA = 0.40; // ±40% dal valore di mercato

// ── Helper: stagione corrente ─────────────────────────────────────────────────
function stagioneCorrente() {
  const oggi = new Date();
  const anno = oggi.getMonth() >= 6 ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return `${anno}-${anno + 1}`;
}

// ── Helper: trova SF per un fantaTeam (più recente) ──────────────────────────
async function findSF(tx, fantaTeamId) {
  return tx.situazioneFinanziaria.findFirst({
    where: { fantaTeamId },
    orderBy: { updatedAt: "desc" },
  }) ?? tx.situazioneFinanziaria.findFirst({
    where: { fantaTeam: { id: fantaTeamId } },
    orderBy: { updatedAt: "desc" },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /mercato/invia-offerta
// ═══════════════════════════════════════════════════════════════════════════════
async function showInviaOfferta(req, res) {
  const myTeam = req.user.fantaTeam;
  if (!myTeam) {
    return res.render("mercato/invia-offerta", {
      currentUser: req.user,
      altriTeam: [], giocatoriTeamSelezionato: [], preselTeamId: null,
      error: "Non hai un FantaTeam assegnato.",
    });
  }

  const teamIdSel = req.query.teamId ? parseInt(req.query.teamId, 10) : null;

  const altriTeam = await prisma.fantaTeam.findMany({
    where: { id: { not: myTeam.id } },
    orderBy: { nome: "asc" },
    include: { user: { select: { nickname: true, email: true } } },
  });

  let giocatoriTeamSelezionato = [];
  if (teamIdSel) {
    // Contratti Acquisto validi del team selezionato con ultima quotazione
    const contratti = await prisma.contratto.findMany({
      where: { fantaTeamId: teamIdSel, tipo: "Acquisto", valido: true },
      include: {
        giocatore: {
          include: {
            quotazioni: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
      },
      orderBy: { giocatore: { nome: "asc" } },
    });
    giocatoriTeamSelezionato = contratti.map(c => ({
      giocatoreId:  c.giocatoreId,
      nome:         c.giocatore.nome,
      ruolo:        c.giocatore.ruolo,
      squadra:      c.giocatore.squadra,
      valore:       c.giocatore.quotazioni[0]?.valore ? Number(c.giocatore.quotazioni[0].valore) : null,
      contrattoId:  c.id,
    }));
  }

  res.render("mercato/invia-offerta", {
    currentUser: req.user,
    altriTeam,
    giocatoriTeamSelezionato,
    preselTeamId: teamIdSel,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
    success: req.query.success === "1",
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /mercato/inbox
// ═══════════════════════════════════════════════════════════════════════════════
async function showInbox(req, res) {
  const myTeam = req.user.fantaTeam;
  if (!myTeam) {
    return res.render("mercato/inbox", {
      currentUser: req.user,
      ricevute: [], inviate: [],
      error: "Non hai un FantaTeam assegnato.",
    });
  }

  const include = {
    giocatore:          { select: { id: true, nome: true, ruolo: true, squadra: true } },
    fantaTeamMittente:  { select: { id: true, nome: true, user: { select: { nickname: true } } } },
    fantaTeamRicevente: { select: { id: true, nome: true, user: { select: { nickname: true } } } },
  };

  const [ricevute, inviate] = await Promise.all([
    prisma.trattativaMercato.findMany({
      where:   { fantaTeamRiceventeId: myTeam.id },
      include,
      orderBy: { createdAt: "desc" },
    }),
    prisma.trattativaMercato.findMany({
      where:   { fantaTeamMittenteId: myTeam.id },
      include,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  res.render("mercato/inbox", {
    currentUser: req.user,
    ricevute,
    inviate,
    error:   req.query.error   ? decodeURIComponent(req.query.error) : null,
    success: req.query.success ? decodeURIComponent(req.query.success) : null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/mercato/offerta  — crea nuova offerta
// ═══════════════════════════════════════════════════════════════════════════════
async function creaOfferta(req, res) {
  const myTeam = req.user.fantaTeam;
  if (!myTeam) return res.status(403).json({ error: "Nessun FantaTeam associato al tuo account." });

  const fantaTeamRiceventeId = parseInt(req.body.fantaTeamRiceventeId, 10);
  const giocatoreId          = parseInt(req.body.giocatoreId, 10);
  const importoOfferta       = parseFloat(req.body.importoOfferta);

  if (!fantaTeamRiceventeId || !giocatoreId || isNaN(importoOfferta) || importoOfferta <= 0) {
    return res.status(400).json({ error: "Parametri mancanti o non validi." });
  }
  if (fantaTeamRiceventeId === myTeam.id) {
    return res.status(400).json({ error: "Non puoi fare un'offerta a te stesso." });
  }

  // Verifica che il giocatore appartenga effettivamente al team ricevente
  const contratto = await prisma.contratto.findFirst({
    where: { giocatoreId, fantaTeamId: fantaTeamRiceventeId, tipo: "Acquisto", valido: true },
  });
  if (!contratto) {
    return res.status(400).json({ error: "Il giocatore non risulta in rosa nel team selezionato." });
  }

  // Ultima quotazione
  const ultimaQuot = await prisma.quotazione.findFirst({
    where:   { giocatoreId },
    orderBy: { createdAt: "desc" },
  });
  if (!ultimaQuot?.valore) {
    return res.status(400).json({ error: "Nessuna quotazione disponibile per questo giocatore. Impossibile validare l'offerta." });
  }
  const valoreRif = Number(ultimaQuot.valore);
  const minOfferta = Math.round(valoreRif * (1 - OFFERTA_DELTA) * 100) / 100;
  const maxOfferta = Math.round(valoreRif * (1 + OFFERTA_DELTA) * 100) / 100;

  if (importoOfferta < minOfferta || importoOfferta > maxOfferta) {
    return res.status(400).json({
      error: `L'offerta deve essere tra ${minOfferta.toFixed(2)} M e ${maxOfferta.toFixed(2)} M (±40% del valore di mercato ${valoreRif.toFixed(2)} M).`,
      minOfferta, maxOfferta, valoreRif,
    });
  }

  // Verifica offerta già in corso sullo stesso giocatore
  const esistente = await prisma.trattativaMercato.findFirst({
    where: { giocatoreId, fantaTeamMittenteId: myTeam.id, stato: "PENDING" },
  });
  if (esistente) {
    return res.status(400).json({ error: "Hai già un'offerta pendente per questo giocatore." });
  }

  // Scadenza: +7 giorni
  const scadenzaAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const trattativa = await prisma.trattativaMercato.create({
    data: {
      giocatoreId,
      fantaTeamMittenteId:  myTeam.id,
      fantaTeamRiceventeId,
      importoOfferta,
      valoreRiferimento:    valoreRif,
      scadenzaAt,
    },
    include: {
      giocatore:         { select: { nome: true } },
      fantaTeamMittente: { select: { nome: true } },
    },
  });

  // Notifica email al presidente ricevente (non bloccante)
  const teamRicevente = await prisma.fantaTeam.findUnique({
    where:  { id: fantaTeamRiceventeId },
    select: { user: { select: { id: true, nickname: true } } },
  });
  if (teamRicevente?.user?.id) {
    sendEmailToUser(
      teamRicevente.user.id,
      `📬 Nuova offerta di mercato per ${trattativa.giocatore.nome}`,
      `<p>Il team <strong>${trattativa.fantaTeamMittente.nome}</strong> ti ha inviato un'offerta di
       <strong>${importoOfferta.toFixed(2)} M</strong> per il giocatore
       <strong>${trattativa.giocatore.nome}</strong>.</p>
       <p>Hai tempo fino al <strong>${scadenzaAt.toLocaleDateString("it-IT")}</strong> per rispondere.</p>
       <p><a href="${process.env.HOST ? "http://" + process.env.HOST + ":" + (process.env.PORT || 3000) : ""}/mercato/inbox">➡️ Vai alla tua Inbox Mercato</a></p>`
    );
  }

  await logAction({
    azione:    "CREATE",
    entita:    "trattativa_mercato",
    entitaId:  trattativa.id,
    dettaglio: {
      giocatoreId,
      fantaTeamMittenteId:  myTeam.id,
      fantaTeamRiceventeId,
      importoOfferta,
      valoreRiferimento:    valoreRif,
    },
    adminId: req.user.id,
  });

  return res.status(201).json({ ok: true, trattativaId: trattativa.id });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/mercato/offerta/:id/risposta  — accetta o rifiuta
// ═══════════════════════════════════════════════════════════════════════════════
async function rispondiOfferta(req, res) {
  const id = parseInt(req.params.id, 10);
  const azione = (req.body.azione || "").toUpperCase(); // "ACCEPT" | "REJECT"
  const motivoRifiuto = (req.body.motivoRifiuto || "").trim() || null;

  if (!["ACCEPT", "REJECT"].includes(azione)) {
    return res.status(400).json({ error: "azione deve essere ACCEPT o REJECT." });
  }

  const myTeam = req.user.fantaTeam;
  const trattativa = await prisma.trattativaMercato.findUnique({
    where:   { id },
    include: { fantaTeamMittente: { select: { nome: true, user: { select: { id: true } } } },
               giocatore: { select: { nome: true } } },
  });

  if (!trattativa) return res.status(404).json({ error: "Trattativa non trovata." });
  if (trattativa.fantaTeamRiceventeId !== myTeam?.id) {
    return res.status(403).json({ error: "Non sei autorizzato a rispondere a questa offerta." });
  }
  if (trattativa.stato !== "PENDING") {
    return res.status(400).json({ error: `La trattativa è già in stato ${trattativa.stato}.` });
  }

  const nuovoStato = azione === "ACCEPT" ? "ACCEPTED" : "REJECTED";

  await prisma.trattativaMercato.update({
    where: { id },
    data:  { stato: nuovoStato, motivoRifiuto: azione === "REJECT" ? motivoRifiuto : null },
  });

  // Notifica al mittente
  if (trattativa.fantaTeamMittente.user?.id) {
    const testoAzione = azione === "ACCEPT" ? "accettata ✅" : "rifiutata ❌";
    sendEmailToUser(
      trattativa.fantaTeamMittente.user.id,
      `Offerta ${testoAzione} per ${trattativa.giocatore.nome}`,
      `<p>La tua offerta di <strong>${Number(trattativa.importoOfferta).toFixed(2)} M</strong>
       per <strong>${trattativa.giocatore.nome}</strong> è stata <strong>${testoAzione}</strong>.</p>
       ${azione === "ACCEPT" ? `<p>Puoi ora procedere alla <a href="/mercato/inbox">finalizzazione del trasferimento</a>.</p>` : ""}
       ${azione === "REJECT" && motivoRifiuto ? `<p>Motivazione: ${motivoRifiuto}</p>` : ""}`
    );
  }

  await logAction({
    azione:    "UPDATE",
    entita:    "trattativa_mercato",
    entitaId:  id,
    dettaglio: { nuovoStato, motivoRifiuto },
    adminId:   req.user.id,
  });

  return res.json({ ok: true, stato: nuovoStato });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/mercato/offerta/:id/finalizza  — esegue il trasferimento
// ═══════════════════════════════════════════════════════════════════════════════
async function finalizzaTransferimento(req, res) {
  const id              = parseInt(req.params.id, 10);
  const anniContratto   = parseInt(req.body.anniContratto, 10);
  const categoria       = req.body.categoria; // InRosa | FuoriRosa | U21
  const CATEGORIE_VALIDE = ["InRosa", "FuoriRosa", "U21"];

  if (isNaN(anniContratto) || anniContratto < 1 || anniContratto > 3) {
    return res.status(400).json({ error: "anniContratto deve essere 1, 2 o 3." });
  }
  if (!CATEGORIE_VALIDE.includes(categoria)) {
    return res.status(400).json({ error: `categoria deve essere uno di: ${CATEGORIE_VALIDE.join(", ")}.` });
  }

  const myTeam = req.user.fantaTeam;
  const trattativa = await prisma.trattativaMercato.findUnique({
    where:   { id },
    include: {
      giocatore:          { select: { id: true, nome: true, ruolo: true } },
      fantaTeamMittente:  { include: { user: { select: { id: true, nickname: true, email: true } } } },
      fantaTeamRicevente: { include: { user: { select: { id: true, nickname: true, email: true } } } },
    },
  });

  if (!trattativa) return res.status(404).json({ error: "Trattativa non trovata." });
  if (trattativa.fantaTeamMittenteId !== myTeam?.id) {
    return res.status(403).json({ error: "Solo l'acquirente può finalizzare il trasferimento." });
  }
  if (trattativa.stato !== "ACCEPTED") {
    return res.status(400).json({ error: `La trattativa deve essere in stato ACCEPTED (attuale: ${trattativa.stato}).` });
  }

  const importo   = Number(trattativa.importoOfferta);
  const stagione  = stagioneCorrente();

  // Calcola dataFine contratto
  const oggi    = new Date();
  const dataFine = `${oggi.getFullYear() + anniContratto}-06-30`;

  let movimentoBuyer = null;
  let movimentoSeller = null;
  let nuovoContratto = null;

  try {
    await prisma.$transaction(async (tx) => {
      // ── A. Situazione finanziaria acquirente ────────────────────────────────
      const sfBuyer = await tx.situazioneFinanziaria.findFirst({
        where:   { fantaTeamId: trattativa.fantaTeamMittenteId },
        orderBy: { updatedAt: "desc" },
      });
      if (!sfBuyer) throw new Error(`Situazione finanziaria non trovata per l'acquirente (teamId=${trattativa.fantaTeamMittenteId}).`);

      const creditiBuyer = Number(sfBuyer.crediti);
      if (creditiBuyer < importo) {
        throw new Error(`Crediti insufficienti: hai ${creditiBuyer.toFixed(2)} M, serve ${importo.toFixed(2)} M.`);
      }

      const creditiBuyerNuovi    = Math.round((creditiBuyer    - importo) * 100) / 100;
      const patrimonioBuyerNuovi = Math.round((Number(sfBuyer.patrimonio) - importo) * 100) / 100;

      await tx.situazioneFinanziaria.update({
        where: { id: sfBuyer.id },
        data:  { crediti: creditiBuyerNuovi, patrimonio: patrimonioBuyerNuovi },
      });
      movimentoBuyer = {
        sfId:      sfBuyer.id,
        ruolo:     "acquirente",
        presidente: trattativa.fantaTeamMittente.user?.nickname,
        crediti:   { prima: creditiBuyer,                  dopo: creditiBuyerNuovi },
        patrimonio:{ prima: Number(sfBuyer.patrimonio),    dopo: patrimonioBuyerNuovi },
      };

      // ── B. Situazione finanziaria venditore ─────────────────────────────────
      const sfSeller = await tx.situazioneFinanziaria.findFirst({
        where:   { fantaTeamId: trattativa.fantaTeamRiceventeId },
        orderBy: { updatedAt: "desc" },
      });
      if (!sfSeller) throw new Error(`Situazione finanziaria non trovata per il venditore (teamId=${trattativa.fantaTeamRiceventeId}).`);

      const creditiSellerNuovi    = Math.round((Number(sfSeller.crediti)    + importo) * 100) / 100;
      const patrimonioSellerNuovi = Math.round((Number(sfSeller.patrimonio) + importo) * 100) / 100;

      await tx.situazioneFinanziaria.update({
        where: { id: sfSeller.id },
        data:  { crediti: creditiSellerNuovi, patrimonio: patrimonioSellerNuovi },
      });
      movimentoSeller = {
        sfId:       sfSeller.id,
        ruolo:      "venditore",
        presidente: trattativa.fantaTeamRicevente.user?.nickname,
        crediti:    { prima: Number(sfSeller.crediti),    dopo: creditiSellerNuovi },
        patrimonio: { prima: Number(sfSeller.patrimonio), dopo: patrimonioSellerNuovi },
      };

      // ── C. Invalida contratto attuale del giocatore ─────────────────────────
      await tx.contratto.updateMany({
        where: {
          giocatoreId: trattativa.giocatoreId,
          fantaTeamId: trattativa.fantaTeamRiceventeId,
          tipo:        "Acquisto",
          valido:      true,
        },
        data: {
          valido:       false,
          destinazione: trattativa.fantaTeamMittente.nome,
        },
      });

      // ── D. Nuovo contratto ──────────────────────────────────────────────────
      nuovoContratto = await tx.contratto.create({
        data: {
          tipo:              "Acquisto",
          dataStipula:       oggi.toISOString().slice(0, 10),
          durataContratto:   anniContratto,
          dataFine,
          giocatoreId:       trattativa.giocatoreId,
          fantaTeamId:       trattativa.fantaTeamMittenteId,
          valoreGiocatore:   trattativa.valoreRiferimento,
          prezzoAcquisto:    importo,
          importoOperazione: importo,
          provenienza:       trattativa.fantaTeamRicevente.nome,
          destinazione:      trattativa.fantaTeamMittente.nome,
          valido:            true,
        },
      });

      // ── E. RosaGiocatore: rimuovi dal venditore, aggiungi all'acquirente ────
      await tx.rosaGiocatore.deleteMany({
        where: {
          fantaTeamId: trattativa.fantaTeamRiceventeId,
          giocatoreId: trattativa.giocatoreId,
          stagione,
        },
      });
      await tx.rosaGiocatore.upsert({
        where: {
          fantaTeamId_giocatoreId_stagione: {
            fantaTeamId: trattativa.fantaTeamMittenteId,
            giocatoreId: trattativa.giocatoreId,
            stagione,
          },
        },
        create: {
          fantaTeamId: trattativa.fantaTeamMittenteId,
          giocatoreId: trattativa.giocatoreId,
          stagione,
          categoria:   categoria,
        },
        update: { categoria },
      });

      // ── F. Marca trattativa COMPLETED ───────────────────────────────────────
      await tx.trattativaMercato.update({
        where: { id },
        data:  { stato: "COMPLETED", contrattoNuovoId: nuovoContratto.id },
      });
    });

    // ── Log fuori transazione ─────────────────────────────────────────────────
    await logAction({
      azione:    "CREATE",
      entita:    "trattativa_mercato",
      entitaId:  id,
      dettaglio: {
        tipo:          "finalizzazione",
        giocatoreId:   trattativa.giocatoreId,
        giocatoreNome: trattativa.giocatore.nome,
        importo,
        anniContratto,
        categoria,
        dataFine,
        contrattoNuovoId: nuovoContratto?.id,
        movimenti: [movimentoBuyer, movimentoSeller],
        rollbackSQL: [
          sfRollbackSQL(movimentoBuyer.sfId,  movimentoBuyer.crediti.prima  !== null ? { crediti: movimentoBuyer.crediti.prima,  patrimonio: movimentoBuyer.patrimonio.prima }  : null),
          sfRollbackSQL(movimentoSeller.sfId, movimentoSeller.crediti.prima !== null ? { crediti: movimentoSeller.crediti.prima, patrimonio: movimentoSeller.patrimonio.prima } : null),
        ].filter(Boolean),
      },
      adminId: req.user.id,
    });

    // Notifica email a entrambi
    const nomGiocatore = trattativa.giocatore.nome;
    if (trattativa.fantaTeamRicevente.user?.id) {
      sendEmailToUser(
        trattativa.fantaTeamRicevente.user.id,
        `✅ Trasferimento completato: ${nomGiocatore}`,
        `<p>Il trasferimento di <strong>${nomGiocatore}</strong> al team
         <strong>${trattativa.fantaTeamMittente.nome}</strong> per
         <strong>${importo.toFixed(2)} M</strong> è stato completato.</p>
         <p>I crediti sono stati accreditati sulla tua situazione finanziaria.</p>`
      );
    }

    return res.json({ ok: true, contrattoNuovoId: nuovoContratto?.id });

  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

module.exports = { showInviaOfferta, showInbox, creaOfferta, rispondiOfferta, finalizzaTransferimento };
