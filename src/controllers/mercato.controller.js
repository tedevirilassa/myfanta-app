// src/controllers/mercato.controller.js
// Trattative di mercato P2P tra fanta-presidenti.
// Flusso: invio offerta → accetta/rifiuta → finalizza trasferimento (transazione ACID).

const prisma = require("../lib/prisma");
const { logAction, sfRollbackSQL } = require("../services/log.service");
const { sendEmailToUser } = require("../services/email.service");
const parametriService = require("../services/parametri.service");

// ── Costanti rimosse: i valori sono ora in tabella Parametro ─────────────────────
// mercato_p2p_delta            (default 0.40)
// mercato_p2p_scadenza_giorni  (default 7)
// contratto_durata_min / max   (default 1 / 3)

// ── Helper: stagione corrente ─────────────────────────────────────────────────
function stagioneCorrente() {
  const oggi = new Date();
  const anno = oggi.getMonth() >= 6 ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return `${anno}-${anno + 1}`;
}

// ── Helper: verifica se dataDecorrenza (MM-YYYY) rientra in una finestra di mercato privato
function isDataDecorrenzaValida(dataDecorrenza, params) {
  const [mm, yyyy] = dataDecorrenza.split("-").map(Number);
  if (!mm || !yyyy || mm < 1 || mm > 12) return { valida: false, errore: "Formato dataDecorrenza non valido (atteso MM-YYYY)." };

  // Finestre: mercato_privato_inizio / mercato_privato_fine (formato GG-MM)
  const parseMese = (ggmm) => parseInt((ggmm || "").split("-")[1], 10);
  const privIz  = parseMese(params.mercato_privato_inizio || "01-07");
  const privFin = parseMese(params.mercato_privato_fine   || "15-02");

  // Finestra che attraversa il capodanno (es. luglio → febbraio): valido se mese >= inizio OR mese <= fine
  let inFinestra;
  if (privIz > privFin) {
    inFinestra = (mm >= privIz || mm <= privFin);
  } else {
    inFinestra = (mm >= privIz && mm <= privFin);
  }

  if (!inFinestra) {
    return { valida: false, errore: `La data di decorrenza (mese ${mm}) non rientra nella finestra di mercato privato (mesi ${privIz}–${privFin}).` };
  }
  return { valida: true };
}

// ── Helper: mese decorrenza → periodo (luglio-dicembre = estivo, gen-giugno = invernale)
function isDecorrenzaEstiva(dataDecorrenza) {
  const mm = parseInt((dataDecorrenza || "").split("-")[0], 10);
  if (!mm) return (new Date().getMonth() + 1) >= 7; // fallback: mese corrente
  return mm >= 7;
}

// ── Helper: calcola stipendio = quotazione × pct, arrotondato a 2 decimali ────
function calcolaStipendio(quotazioneValore, pct) {
  return Math.round(Number(quotazioneValore) * Number(pct) * 100) / 100;
}

// ── Helper: controlla se dataDecorrenza corrisponde al mese corrente ──────────
function isDecorrenzaImmediata(dataDecorrenza) {
  const [mm, yyyy] = dataDecorrenza.split("-").map(Number);
  const oggi = new Date();
  return oggi.getFullYear() === yyyy && (oggi.getMonth() + 1) === mm;
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

  const _params = await parametriService.getAll();
  const delta   = parseFloat(_params.mercato_p2p_delta || "0.40");

  res.render("mercato/invia-offerta", {
    currentUser: req.user,
    altriTeam,
    giocatoriTeamSelezionato,
    preselTeamId: teamIdSel,
    delta,
    params: _params,
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
  const dataDecorrenza       = (req.body.dataDecorrenza || "").trim(); // MM-YYYY

  if (!fantaTeamRiceventeId || !giocatoreId || isNaN(importoOfferta) || importoOfferta <= 0) {
    return res.status(400).json({ error: "Parametri mancanti o non validi." });
  }
  if (!dataDecorrenza || !/^\d{2}-\d{4}$/.test(dataDecorrenza)) {
    return res.status(400).json({ error: "dataDecorrenza obbligatoria (formato MM-YYYY)." });
  }
  if (fantaTeamRiceventeId === myTeam.id) {
    return res.status(400).json({ error: "Non puoi fare un'offerta a te stesso." });
  }

  // Validazione dataDecorrenza rispetto alle finestre di mercato privato
  const _params = await parametriService.getAll();
  const { valida, errore } = isDataDecorrenzaValida(dataDecorrenza, _params);
  if (!valida) {
    return res.status(400).json({ error: errore });
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
  const ofDelta   = parseFloat(_params.mercato_p2p_delta || "0.40");
  const minOfferta = Math.round(valoreRif * (1 - ofDelta) * 100) / 100;
  const maxOfferta = Math.round(valoreRif * (1 + ofDelta) * 100) / 100;

  if (importoOfferta < minOfferta || importoOfferta > maxOfferta) {
    return res.status(400).json({
      error: `L'offerta deve essere tra ${minOfferta.toFixed(2)} M e ${maxOfferta.toFixed(2)} M (±${Math.round(ofDelta*100)}% del valore di mercato ${valoreRif.toFixed(2)} M).`,
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

  // Scadenza: N giorni da parametro
  const scadenzaGiorni = parseInt(_params.mercato_p2p_scadenza_giorni || "7", 10);
  const scadenzaAt = new Date(Date.now() + scadenzaGiorni * 24 * 60 * 60 * 1000);

  const trattativa = await prisma.trattativaMercato.create({
    data: {
      giocatoreId,
      fantaTeamMittenteId:  myTeam.id,
      fantaTeamRiceventeId,
      importoOfferta,
      valoreRiferimento:    valoreRif,
      dataDecorrenza,
      tipoContratto,
      clausola:             clausola || null,
      importoClausola:      importoClausola ?? null,
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
       <p>L'operazione, se accettata, diventerà effettiva in data <strong>${dataDecorrenza}</strong>.</p>
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
      dataDecorrenza,
      tipoContratto,
      clausola:             clausola || null,
      importoClausola:      importoClausola ?? null,
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
// Se dataDecorrenza = mese corrente → esecuzione immediata.
// Se dataDecorrenza = futuro → crea contratto con valido=false, nessun
// movimento rosa/crediti; lo stato diventa COMPLETED_DEFERRED. L'attivazione
// avviene tramite il job `attivaTrattativeDifferite`.
// ═══════════════════════════════════════════════════════════════════════════════
async function finalizzaTransferimento(req, res) {
  const id              = parseInt(req.params.id, 10);
  const anniContratto   = parseInt(req.body.anniContratto, 10);
  const categoria       = req.body.categoria; // InRosa | FuoriRosa | U21
  const CATEGORIE_VALIDE = ["InRosa", "FuoriRosa", "U21"];

  const params          = await parametriService.getAll();
  const durataMin       = parseInt(params.contratto_durata_min || "1", 10);
  const durataMax       = parseInt(params.contratto_durata_max || "3", 10);

  if (isNaN(anniContratto) || anniContratto < durataMin || anniContratto > durataMax) {
    return res.status(400).json({ error: `anniContratto deve essere tra ${durataMin} e ${durataMax}.` });
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

  const importo        = Number(trattativa.importoOfferta);
  const stagione       = stagioneCorrente();
  const dataDecorrenza = trattativa.dataDecorrenza; // MM-YYYY
  const immediato      = !dataDecorrenza || isDecorrenzaImmediata(dataDecorrenza);

  // dataStipula: per immediato = oggi; per differito = dataDecorrenza
  const oggi           = new Date();
  const dataStipula    = immediato
    ? oggi.toISOString().slice(0, 10)
    : dataDecorrenza; // MM-YYYY (stesso formato usato altrove)

  // dataFine: calcolata dal mese/anno di decorrenza
  let dataFine;
  if (immediato) {
    dataFine = `${oggi.getFullYear() + anniContratto}-06-30`;
  } else {
    const [mm, yyyy] = dataDecorrenza.split("-").map(Number);
    dataFine = `${yyyy + anniContratto}-06-30`;
  }

  let movimentoBuyer  = null;
  let movimentoSeller = null;
  let nuovoContratto  = null;

  try {
    await prisma.$transaction(async (tx) => {
      if (immediato) {
        // ══════════════════════════════════════════════════════════════════════
        // ESECUZIONE IMMEDIATA
        // ══════════════════════════════════════════════════════════════════════

        // ── 0. Calcolo stipendi pro-rata (prima di leggere le SF) ─────────────
        const vecchioContratto = await tx.contratto.findFirst({
          where:   { giocatoreId: trattativa.giocatoreId, fantaTeamId: trattativa.fantaTeamRiceventeId, tipo: "Acquisto", valido: true },
          orderBy: { createdAt: "desc" },
        });
        const stipendioVecchio = vecchioContratto
          ? Math.round(Number(vecchioContratto.importoOperazione || 0) * 100) / 100
          : 0;

        const ultimaQuotTx = await tx.quotazione.findFirst({
          where:   { giocatoreId: trattativa.giocatoreId },
          orderBy: { createdAt: "desc" },
        });
        const quotVal = ultimaQuotTx?.valore ? Number(ultimaQuotTx.valore) : Number(trattativa.valoreRiferimento);

        const estivo         = isDecorrenzaEstiva(dataDecorrenza);
        const stipendioPct   = estivo
          ? parseFloat(params.stipendio_percentuale           || "0.10")
          : parseFloat(params.stipendio_percentuale_invernale || "0.05");
        const stipendioNuovo = calcolaStipendio(quotVal, stipendioPct);
        const rimborsoSeller = estivo
          ? stipendioVecchio
          : Math.round(stipendioVecchio * 0.5 * 100) / 100;

        // ── A. Situazione finanziaria acquirente ──────────────────────────────
        const sfBuyer = await tx.situazioneFinanziaria.findFirst({
          where:   { fantaTeamId: trattativa.fantaTeamMittenteId },
          orderBy: { updatedAt: "desc" },
        });
        if (!sfBuyer) throw new Error(`Situazione finanziaria non trovata per l'acquirente (teamId=${trattativa.fantaTeamMittenteId}).`);

        const creditiBuyer = Number(sfBuyer.crediti);
        const totaleDovuto = Math.round((importo + stipendioNuovo) * 100) / 100;
        if (creditiBuyer < totaleDovuto) {
          throw new Error(`Crediti insufficienti: hai ${creditiBuyer.toFixed(2)} M, serve ${totaleDovuto.toFixed(2)} M (cartellino ${importo.toFixed(2)} + stipendio ${stipendioNuovo.toFixed(2)}).`);
        }

        const creditiBuyerNuovi    = Math.round((creditiBuyer - totaleDovuto) * 100) / 100;
        const patrimonioBuyerNuovi = Math.round((Number(sfBuyer.patrimonio) - totaleDovuto) * 100) / 100;
        const stipendiBuyerNuovi   = Math.round((Number(sfBuyer.stipendi)   + stipendioNuovo) * 100) / 100;

        await tx.situazioneFinanziaria.update({
          where: { id: sfBuyer.id },
          data:  { crediti: creditiBuyerNuovi, patrimonio: patrimonioBuyerNuovi, stipendi: stipendiBuyerNuovi },
        });
        movimentoBuyer = {
          sfId:       sfBuyer.id,
          ruolo:      "acquirente",
          presidente: trattativa.fantaTeamMittente.user?.nickname,
          crediti:    { prima: creditiBuyer,               dopo: creditiBuyerNuovi },
          patrimonio: { prima: Number(sfBuyer.patrimonio), dopo: patrimonioBuyerNuovi },
          stipendi:   { prima: Number(sfBuyer.stipendi),   dopo: stipendiBuyerNuovi },
        };

        // ── B. Situazione finanziaria venditore ───────────────────────────────
        const sfSeller = await tx.situazioneFinanziaria.findFirst({
          where:   { fantaTeamId: trattativa.fantaTeamRiceventeId },
          orderBy: { updatedAt: "desc" },
        });
        if (!sfSeller) throw new Error(`Situazione finanziaria non trovata per il venditore (teamId=${trattativa.fantaTeamRiceventeId}).`);

        const creditiSellerNuovi    = Math.round((Number(sfSeller.crediti)    + importo + rimborsoSeller) * 100) / 100;
        const patrimonioSellerNuovi = Math.round((Number(sfSeller.patrimonio) + importo) * 100) / 100;
        const stipendiSellerNuovi   = Math.round((Number(sfSeller.stipendi)   - rimborsoSeller) * 100) / 100;

        await tx.situazioneFinanziaria.update({
          where: { id: sfSeller.id },
          data:  { crediti: creditiSellerNuovi, patrimonio: patrimonioSellerNuovi, stipendi: stipendiSellerNuovi },
        });
        movimentoSeller = {
          sfId:       sfSeller.id,
          ruolo:      "venditore",
          presidente: trattativa.fantaTeamRicevente.user?.nickname,
          crediti:    { prima: Number(sfSeller.crediti),    dopo: creditiSellerNuovi },
          patrimonio: { prima: Number(sfSeller.patrimonio), dopo: patrimonioSellerNuovi },
          stipendi:   { prima: Number(sfSeller.stipendi),   dopo: stipendiSellerNuovi },
        };

        // ── C. Invalida contratto attuale del giocatore ───────────────────────
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

        // ── D. Nuovo contratto (importoOperazione = stipendio calcolato) ──────
        nuovoContratto = await tx.contratto.create({
          data: {
            tipo:              trattativa.tipoContratto || "Acquisto",
            clausola:          trattativa.clausola || null,
            dataStipula,
            durataContratto:   anniContratto,
            dataFine,
            giocatoreId:       trattativa.giocatoreId,
            fantaTeamId:       trattativa.fantaTeamMittenteId,
            valoreGiocatore:   trattativa.valoreRiferimento,
            prezzoAcquisto:    importo,
            importoOperazione: stipendioNuovo,
            provenienza:       trattativa.fantaTeamRicevente.nome,
            destinazione:      trattativa.fantaTeamMittente.nome,
            valido:            true,
          },
        });

        // ── E. RosaGiocatore: rimuovi dal venditore, aggiungi all'acquirente ──
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
            categoria,
          },
          update: { categoria },
        });

        // ── F. Marca trattativa COMPLETED ─────────────────────────────────────
        await tx.trattativaMercato.update({
          where: { id },
          data:  { stato: "COMPLETED", contrattoNuovoId: nuovoContratto.id },
        });

      } else {
        // ══════════════════════════════════════════════════════════════════════
        // DECORRENZA FUTURA — crea contratto con valido=false, nessun
        // movimento crediti/rosa. L'attivazione avverrà al raggiungimento
        // della data di decorrenza tramite job.
        // ══════════════════════════════════════════════════════════════════════

        // Stima stipendio provvisoria basata su quotazione attuale e periodo di decorrenza.
        // Verrà ricalcolata alla data di attivazione con la quotazione aggiornata.
        const ultimaQuotDef  = await tx.quotazione.findFirst({
          where:   { giocatoreId: trattativa.giocatoreId },
          orderBy: { createdAt: "desc" },
        });
        const quotValDef      = ultimaQuotDef?.valore ? Number(ultimaQuotDef.valore) : Number(trattativa.valoreRiferimento);
        const estivoDef       = isDecorrenzaEstiva(dataDecorrenza);
        const stipendioPctDef = estivoDef
          ? parseFloat(params.stipendio_percentuale           || "0.10")
          : parseFloat(params.stipendio_percentuale_invernale || "0.05");
        const stipendioNuovoDef = calcolaStipendio(quotValDef, stipendioPctDef);

        nuovoContratto = await tx.contratto.create({
          data: {
            tipo:              trattativa.tipoContratto || "Acquisto",
            clausola:          trattativa.clausola || null,
            dataStipula,
            durataContratto:   anniContratto,
            dataFine,
            giocatoreId:       trattativa.giocatoreId,
            fantaTeamId:       trattativa.fantaTeamMittenteId,
            valoreGiocatore:   trattativa.valoreRiferimento,
            prezzoAcquisto:    importo,
            importoOperazione: stipendioNuovoDef, // stima; aggiornata all'attivazione
            provenienza:       trattativa.fantaTeamRicevente.nome,
            destinazione:      trattativa.fantaTeamMittente.nome,
            valido:            false, // NON attivo fino alla decorrenza
          },
        });

        await tx.trattativaMercato.update({
          where: { id },
          data:  { stato: "COMPLETED_DEFERRED", contrattoNuovoId: nuovoContratto.id },
        });
      }
    });

    // ── Log fuori transazione ─────────────────────────────────────────────────
    const tipoOperazione = immediato ? "immediata" : "differita";
    await logAction({
      azione:    "CREATE",
      entita:    "trattativa_mercato",
      entitaId:  id,
      dettaglio: {
        tipo:             "finalizzazione",
        tipo_operazione:  tipoOperazione,
        decorrenza:       dataDecorrenza || null,
        giocatoreId:      trattativa.giocatoreId,
        giocatoreNome:    trattativa.giocatore.nome,
        importo,
        anniContratto,
        categoria,
        dataFine,
        contrattoNuovoId: nuovoContratto?.id,
        ...(immediato && {
          movimenti: [movimentoBuyer, movimentoSeller],
          stipendioNuovo,
          rimborsoSeller,
          rollbackSQL: [
            sfRollbackSQL(movimentoBuyer.sfId,  { crediti: movimentoBuyer.crediti.prima,  patrimonio: movimentoBuyer.patrimonio.prima,  stipendi: movimentoBuyer.stipendi.prima }),
            sfRollbackSQL(movimentoSeller.sfId, { crediti: movimentoSeller.crediti.prima, patrimonio: movimentoSeller.patrimonio.prima, stipendi: movimentoSeller.stipendi.prima }),
          ].filter(Boolean),
        }),
      },
      adminId: req.user.id,
    });

    // Notifica email a entrambi
    const nomGiocatore = trattativa.giocatore.nome;
    if (immediato) {
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
    } else {
      // Email di conferma operazione differita
      const destinatari = [trattativa.fantaTeamRicevente.user?.id, trattativa.fantaTeamMittente.user?.id].filter(Boolean);
      for (const uid of destinatari) {
        sendEmailToUser(
          uid,
          `📅 Trasferimento differito confermato: ${nomGiocatore}`,
          `<p>Il trasferimento di <strong>${nomGiocatore}</strong> dal team
           <strong>${trattativa.fantaTeamRicevente.nome}</strong> al team
           <strong>${trattativa.fantaTeamMittente.nome}</strong> per
           <strong>${importo.toFixed(2)} M</strong> è stato registrato con
           decorrenza <strong>${dataDecorrenza}</strong>.</p>
           <p>Il giocatore resterà nella rosa attuale e i crediti non saranno movimentati fino al raggiungimento della data di decorrenza.</p>`
        );
      }
    }

    return res.json({ ok: true, contrattoNuovoId: nuovoContratto?.id, differito: !immediato });

  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOB: attivaTrattativeDifferite
// Chiamato dall'admin panel o da un cron. Trova tutte le trattative
// COMPLETED_DEFERRED la cui dataDecorrenza corrisponde al mese corrente (o è
// passata), ed esegue il trasferimento effettivo (crediti + rosa).
// ═══════════════════════════════════════════════════════════════════════════════
async function attivaTrattativeDifferite() {
  const oggi    = new Date();
  const mmOggi  = oggi.getMonth() + 1;
  const yyyyOggi = oggi.getFullYear();
  const stagione = stagioneCorrente();

  const pendenti = await prisma.trattativaMercato.findMany({
    where: { stato: "COMPLETED_DEFERRED" },
    include: {
      giocatore:          { select: { id: true, nome: true } },
      fantaTeamMittente:  { include: { user: { select: { id: true, nickname: true } } } },
      fantaTeamRicevente: { include: { user: { select: { id: true, nickname: true } } } },
    },
  });

  const params     = await parametriService.getAll();
  const risultati  = { attivati: 0, errori: [] };

  for (const t of pendenti) {
    const [mm, yyyy] = (t.dataDecorrenza || "").split("-").map(Number);
    if (!mm || !yyyy) continue;

    // Attiva solo se mese/anno corrente >= decorrenza
    const decDate  = new Date(yyyy, mm - 1, 1);
    const oggiDate = new Date(yyyyOggi, mmOggi - 1, 1);
    if (oggiDate < decDate) continue; // non ancora raggiunta

    const importo = Number(t.importoOfferta);
    let movBuyerAct  = null;
    let movSellerAct = null;
    let stipendioNuovoAct = 0;

    try {
      await prisma.$transaction(async (tx) => {
        // ── 0. Calcolo stipendi pro-rata al momento dell'attivazione ──────────
        const vecchioContrattoAct = await tx.contratto.findFirst({
          where:   { giocatoreId: t.giocatoreId, fantaTeamId: t.fantaTeamRiceventeId, tipo: "Acquisto", valido: true },
          orderBy: { createdAt: "desc" },
        });
        const stipendioVecchioAct = vecchioContrattoAct
          ? Math.round(Number(vecchioContrattoAct.importoOperazione || 0) * 100) / 100
          : 0;

        const ultimaQuotAct = await tx.quotazione.findFirst({
          where:   { giocatoreId: t.giocatoreId },
          orderBy: { createdAt: "desc" },
        });
        const quotValAct = ultimaQuotAct?.valore ? Number(ultimaQuotAct.valore) : Number(t.valoreRiferimento);

        const estivoAct      = isDecorrenzaEstiva(t.dataDecorrenza);
        const stipendioPct   = estivoAct
          ? parseFloat(params.stipendio_percentuale           || "0.10")
          : parseFloat(params.stipendio_percentuale_invernale || "0.05");
        stipendioNuovoAct    = calcolaStipendio(quotValAct, stipendioPct);
        const rimborsoSellerAct = estivoAct
          ? stipendioVecchioAct
          : Math.round(stipendioVecchioAct * 0.5 * 100) / 100;

        // ── A. Crediti acquirente (cartellino + stipendio) ─────────────────────
        const sfBuyer = await tx.situazioneFinanziaria.findFirst({
          where: { fantaTeamId: t.fantaTeamMittenteId },
          orderBy: { updatedAt: "desc" },
        });
        if (!sfBuyer) throw new Error(`SF non trovata per acquirente teamId=${t.fantaTeamMittenteId}`);
        const creditiBuyer = Number(sfBuyer.crediti);
        const totaleDovuto = Math.round((importo + stipendioNuovoAct) * 100) / 100;
        if (creditiBuyer < totaleDovuto) throw new Error(`Crediti insufficienti per attivazione differita (teamId=${t.fantaTeamMittenteId}): ${creditiBuyer.toFixed(2)} < ${totaleDovuto.toFixed(2)}`);

        const creditiBuyerNuovi  = Math.round((creditiBuyer - totaleDovuto) * 100) / 100;
        const patrimBuyerNuovi   = Math.round((Number(sfBuyer.patrimonio)   - totaleDovuto) * 100) / 100;
        const stipendiBuyerNuovi = Math.round((Number(sfBuyer.stipendi)     + stipendioNuovoAct) * 100) / 100;
        await tx.situazioneFinanziaria.update({
          where: { id: sfBuyer.id },
          data:  { crediti: creditiBuyerNuovi, patrimonio: patrimBuyerNuovi, stipendi: stipendiBuyerNuovi },
        });
        movBuyerAct = {
          sfId:       sfBuyer.id,
          ruolo:      "acquirente",
          crediti:    { prima: creditiBuyer,               dopo: creditiBuyerNuovi },
          patrimonio: { prima: Number(sfBuyer.patrimonio), dopo: patrimBuyerNuovi },
          stipendi:   { prima: Number(sfBuyer.stipendi),   dopo: stipendiBuyerNuovi },
        };

        // ── B. Crediti venditore (cartellino + rimborso stipendio) ─────────────
        const sfSeller = await tx.situazioneFinanziaria.findFirst({
          where: { fantaTeamId: t.fantaTeamRiceventeId },
          orderBy: { updatedAt: "desc" },
        });
        if (!sfSeller) throw new Error(`SF non trovata per venditore teamId=${t.fantaTeamRiceventeId}`);

        const creditiSellerNuovi  = Math.round((Number(sfSeller.crediti)    + importo + rimborsoSellerAct) * 100) / 100;
        const patrimSellerNuovi   = Math.round((Number(sfSeller.patrimonio) + importo) * 100) / 100;
        const stipendiSellerNuovi = Math.round((Number(sfSeller.stipendi)   - rimborsoSellerAct) * 100) / 100;
        await tx.situazioneFinanziaria.update({
          where: { id: sfSeller.id },
          data:  { crediti: creditiSellerNuovi, patrimonio: patrimSellerNuovi, stipendi: stipendiSellerNuovi },
        });
        movSellerAct = {
          sfId:       sfSeller.id,
          ruolo:      "venditore",
          crediti:    { prima: Number(sfSeller.crediti),    dopo: creditiSellerNuovi },
          patrimonio: { prima: Number(sfSeller.patrimonio), dopo: patrimSellerNuovi },
          stipendi:   { prima: Number(sfSeller.stipendi),   dopo: stipendiSellerNuovi },
        };

        // ── C. Invalida contratto attuale giocatore ────────────────────────────
        await tx.contratto.updateMany({
          where: {
            giocatoreId: t.giocatoreId,
            fantaTeamId: t.fantaTeamRiceventeId,
            tipo:        "Acquisto",
            valido:      true,
          },
          data: {
            valido:       false,
            destinazione: t.fantaTeamMittente.nome,
          },
        });

        // ── D. Attiva il contratto pre-creato e aggiorna importoOperazione ─────
        if (t.contrattoNuovoId) {
          await tx.contratto.update({
            where: { id: t.contrattoNuovoId },
            data:  { valido: true, importoOperazione: stipendioNuovoAct },
          });
        }

        // ── E. Rosa: rimuovi dal venditore, aggiungi all'acquirente ────────────
        await tx.rosaGiocatore.deleteMany({
          where: {
            fantaTeamId: t.fantaTeamRiceventeId,
            giocatoreId: t.giocatoreId,
            stagione,
          },
        });
        await tx.rosaGiocatore.create({
          data: {
            fantaTeamId: t.fantaTeamMittenteId,
            giocatoreId: t.giocatoreId,
            stagione,
            categoria:   "InRosa",
          },
        });

        // ── F. Marca COMPLETED ─────────────────────────────────────────────────
        await tx.trattativaMercato.update({
          where: { id: t.id },
          data:  { stato: "COMPLETED" },
        });
      });

      await logAction({
        azione:    "UPDATE",
        entita:    "trattativa_mercato",
        entitaId:  t.id,
        dettaglio: {
          tipo_operazione: "attivazione_differita",
          decorrenza:      t.dataDecorrenza,
          giocatoreNome:   t.giocatore.nome,
          importo,
          stipendioNuovo:  stipendioNuovoAct,
          movimenti:       [movBuyerAct, movSellerAct].filter(Boolean),
          rollbackSQL: [
            sfRollbackSQL(movBuyerAct?.sfId,  movBuyerAct  ? { crediti: movBuyerAct.crediti.prima,  patrimonio: movBuyerAct.patrimonio.prima,  stipendi: movBuyerAct.stipendi.prima }  : null),
            sfRollbackSQL(movSellerAct?.sfId, movSellerAct ? { crediti: movSellerAct.crediti.prima, patrimonio: movSellerAct.patrimonio.prima, stipendi: movSellerAct.stipendi.prima } : null),
          ].filter(Boolean),
        },
        adminId: null,
      });

      risultati.attivati++;
    } catch (err) {
      risultati.errori.push({ trattativaId: t.id, giocatore: t.giocatore.nome, errore: err.message });
    }
  }

  return risultati;
}

module.exports = { showInviaOfferta, showInbox, creaOfferta, rispondiOfferta, finalizzaTransferimento, attivaTrattativeDifferite };
