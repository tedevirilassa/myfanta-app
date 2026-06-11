// src/controllers/fine-stagione.controller.js
// Job di rollover fine stagione (30 giugno). Eseguito in unica transazione
// ACID: se qualsiasi step fallisce → ROLLBACK totale.

const prisma = require("../lib/prisma");
const parametriService = require("../services/parametri.service");
const { sfRollbackSQL } = require("../services/log.service");
const { modificaCreditiTeam, CAUSALI } = require("../services/finanze.service");

// ── Helpers ─────────────────────────────────────────────────────────────────

function stagioneCorrente(meseInizio) {
  const oggi = new Date();
  const meseOggi = oggi.getMonth() + 1;
  const anno = meseOggi >= meseInizio ? oggi.getFullYear() : oggi.getFullYear() - 1;
  return { stagione: `${anno}-${anno + 1}`, annoInizio: anno };
}

function stagioneSuccessiva(s) {
  const [a] = s.split("-").map(Number);
  return `${a + 1}-${a + 2}`;
}

async function calcSalaryCapGlobale(tx, params) {
  const salaryCapPct = parseFloat(params.rinnovi_salary_cap_pct || "0.25");
  const stipPct      = parseFloat(params.stipendio_percentuale  || "0.10");
  const teams = await tx.fantaTeam.findMany({ select: { id: true } });
  const valori = [];
  for (const t of teams) {
    const contratti = await tx.contratto.findMany({
      where: { fantaTeamId: t.id, valido: true, tipo: "Acquisto" },
      include: { giocatore: { select: { id: true, valore: true, active: true } } },
    });
    let rosa = 0;
    const seen = new Set();
    for (const c of contratti) {
      if (!c.giocatore.active) continue;
      if (seen.has(c.giocatoreId)) continue;
      seen.add(c.giocatoreId);
      rosa += c.giocatore.valore ? Number(c.giocatore.valore) : 0;
    }
    if (rosa > 0) valori.push(rosa);
  }
  if (valori.length === 0) return 0;
  const maxR = Math.max(...valori);
  const minR = Math.min(...valori);
  return Math.round(((maxR + minR) / 2) * salaryCapPct * stipPct * 100) / 100;
}

async function ultimaQuotazione(tx, giocatoreId, fallbackGiocatoreValore) {
  const q = await tx.quotazione.findFirst({
    where:   { giocatoreId, fonte: "transfermarkt" },
    orderBy: { createdAt: "desc" },
    select:  { valore: true },
  });
  if (q && q.valore != null) return Number(q.valore);
  return fallbackGiocatoreValore != null ? Number(fallbackGiocatoreValore) : 0;
}

// ── GET /admin/fine-stagione ───────────────────────────────────────────────
async function showFineStagione(req, res) {
  const params = await parametriService.getAll();
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const oggi = new Date();
  const meseOggi = oggi.getMonth() + 1;
  const annoOggi = oggi.getFullYear();
  const annoStagione = meseOggi >= meseInizio ? annoOggi : annoOggi - 1;
  const stagioneOld = `${annoStagione}-${annoStagione + 1}`;
  const stagioneNew = stagioneSuccessiva(stagioneOld);

  // Preview counters senza modificare nulla
  const contrattiValidi = await prisma.contratto.count({ where: { valido: true } });
  const proposteAttese  = await prisma.propostaRinnovo.count({
    where: { status: "PENDING" },
  });
  // "scadenze naturali" = durataContratto<=1 escludendo i contratti con dataFine
  // in anni futuri (protetti dal rollover)
  const annoFineStagione = annoStagione + 1;
  const candidati = await prisma.contratto.findMany({
    where: { valido: true, durataContratto: { lte: 1 } },
    select: { id: true, dataFine: true },
  });
  const scadenzeNaturali = candidati.filter((c) => {
    if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) return true;
    return parseInt(c.dataFine.split("-")[1], 10) <= annoFineStagione;
  }).length;

  res.render("admin/fine-stagione", {
    currentUser: req.user,
    stagioneOld, stagioneNew,
    contrattiValidi, proposteAttese, scadenzeNaturali, params,
    message: req.query.ok ? `Rollover eseguito: ${req.query.dec || 0} contratti aggiornati · ${req.query.svi || 0} svincoli · ${req.query.rin || 0} rinnovi.` : null,
    error:   req.query.error ? decodeURIComponent(req.query.error) : null,
  });
}

// ── POST /admin/fine-stagione/esegui ───────────────────────────────────────
// Esecuzione strict-order in $transaction:
//  1. (rimosso) Decremento durata — la durata residua è calcolata dinamicamente da dataFine.
//  2. Simula rinnovi: marca proposte APPROVED/REJECTED in base a cap.
//  3. Svincoli: contratti con dataFine scaduta E non rinnovati, + proposte REJECTED.
//  4. Rinnovi APPROVED: chiude vecchio + crea nuovo con quotazione corrente.
//  5. Log dettaglio per ogni variazione.
async function eseguiFineStagione(req, res) {
  const params = await parametriService.getAll();
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const sCorrente = stagioneCorrente(meseInizio);
  const stagioneOld = sCorrente.stagione;
  const stagioneNew = stagioneSuccessiva(stagioneOld);
  const annoCorrente = sCorrente.annoInizio + 1; // 30 giugno = fine stagione, nuovo anno = annoInizio+1
  const dataStipulaNuova = `${String(meseInizio).padStart(2, "0")}-${annoCorrente}`;
  const ADMIN_ID = req.user.id;
  const PCT_STIPENDIO = parseFloat(params.stipendio_percentuale || "0.10");

  try {
    const report = await prisma.$transaction(async (tx) => {
      const annoFineStagione = sCorrente.annoInizio + 1; // es. 2026 per stagione 2025-2026

      // ── PROTEZIONE: contratti con dataFine in anni FUTURI non sono mai candidati
      // né per svincolo né per rinnovo. La loro vita è governata solo da dataFine.
      const tuttiValidiPreDec = await tx.contratto.findMany({
        where: { valido: true },
        select: { id: true, dataFine: true },
      });
      const idsDataFineFutura = new Set(
        tuttiValidiPreDec
          .filter((c) => {
            if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) return false;
            return parseInt(c.dataFine.split("-")[1], 10) > annoFineStagione;
          })
          .map((c) => c.id)
      );

      // ── Step 1: Decremento Temporale ─── RIMOSSO (2026-06-09) ───────────
      // La durata residua di un contratto è ora derivata dinamicamente da
      // `dataFine`, quindi non c'è più alcun decremento da applicare al
      // rollover di fine stagione. Manteniamo `dec` per non rompere il report.
      const dec = { count: 0 };

      // ── Step 2: Simula rinnovi → APPROVED / REJECTED ──────────────────
      const cap = await calcSalaryCapGlobale(tx, params);
      const teams = await tx.fantaTeam.findMany({ include: { user: true } });
      const approved = [];
      const rejected = [];

      for (const team of teams) {
        const proposte = await tx.propostaRinnovo.findMany({
          where:   { fantaTeamId: team.id, status: "PENDING" },
          orderBy: { ordinePriorita: "asc" },
          include: { contratto: true, giocatore: true },
        });
        let speso = 0;
        for (const p of proposte) {
          // PROTEZIONE: ignora proposte su contratti con dataFine futura
          if (idsDataFineFutura.has(p.contrattoId)) continue;
          const quotValore = await ultimaQuotazione(tx, p.giocatoreId, p.giocatore.valore);
          const ingaggio = Math.round(quotValore * PCT_STIPENDIO * 100) / 100;
          if (cap > 0 && speso + ingaggio <= cap + 1e-9) {
            approved.push({ proposta: p, team, quotValore, ingaggio });
            speso += ingaggio;
          } else {
            rejected.push({ proposta: p, team, quotValore, ingaggio });
          }
        }
      }

      const idsApprovedContrattoVecchio = new Set(approved.map((x) => x.proposta.contrattoId));
      const idsRejectedContrattoVecchio = new Set(rejected.map((x) => x.proposta.contrattoId));

      // ── Step 3: SVINCOLI ────────────────────────────────────────────────
      // (a) Contratti validi con durataContratto<=0 dopo decrement (scaduti naturalmente)
      //     E non oggetto di rinnovo APPROVED.
      // (b) Contratti con proposta REJECTED.
      // (c) GUARDIA EXTRA: contratti con dataFine nel formato MM-YYYY il cui anno
      //     <= annoFineStagione, a prescindere da durataContratto (copre import errati
      //     o contratti aggiunti a stagione iniziata senza passare dal flusso rinnovi).
      // NOTA: i giocatori in slot U21 sono SEMPRE esclusi dagli svincoli di fine stagione.
      //       Lo slot U21 "congela" il giocatore: contratto valido indipendentemente da
      //       dataFine, durataContratto o assenza dallo scraping Transfermarkt.
      // NOTA: i contratti con dataFine in anni futuri (idsDataFineFutura) sono SEMPRE esclusi.

      // Raccogli tutti i giocatoreId in slot U21 per team
      const rosaU21Rows = await tx.rosaGiocatore.findMany({
        where: { categoria: "U21" },
        select: { fantaTeamId: true, giocatoreId: true },
      });
      // Set di chiavi composte "fantaTeamId:giocatoreId" per lookup O(1)
      const u21Keys = new Set(rosaU21Rows.map((r) => `${r.fantaTeamId}:${r.giocatoreId}`));

      // Contratti validi con dataFine scaduta per anno (filtro JS su stringa MM-YYYY)
      const tuttiValidi = await tx.contratto.findMany({
        where: { valido: true, NOT: [{ id: { in: Array.from(idsApprovedContrattoVecchio) } }] },
        select: { id: true, dataFine: true, fantaTeamId: true, giocatoreId: true },
      });
      const idsDataFineScaduta = new Set(
        tuttiValidi
          .filter((c) => {
            if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) return false;
            if (u21Keys.has(`${c.fantaTeamId}:${c.giocatoreId}`)) return false; // U21 protetti
            return parseInt(c.dataFine.split("-")[1], 10) <= annoFineStagione;
          })
          .map((c) => c.id)
      );

      const candidatiSvincolo = await tx.contratto.findMany({
        where: {
          valido: true,
          OR: [
            { durataContratto: { lte: 0 } },
            { id: { in: Array.from(idsRejectedContrattoVecchio) } },
            { id: { in: Array.from(idsDataFineScaduta) } },
          ],
          NOT: [
            // Esclude i contratti rinnovati (verranno chiusi nel passo Rinnovi)
            { id: { in: Array.from(idsApprovedContrattoVecchio) } },
            // PROTEZIONE: esclude contratti con dataFine in anni futuri (mai svincolabili)
            { id: { in: Array.from(idsDataFineFutura) } },
          ],
        },
        include: { giocatore: true, fantaTeam: { include: { user: true } } },
      });

      // Filtra ulteriormente: rimuovi qualsiasi U21 rimasto (es. durataContratto<=0)
      const candidatiSvincoloFiltrati = candidatiSvincolo.filter(
        (c) => !u21Keys.has(`${c.fantaTeamId}:${c.giocatoreId}`)
      );

      let svincoliApplicati = 0;
      for (const c of candidatiSvincoloFiltrati) {
        const quotValore = await ultimaQuotazione(tx, c.giocatoreId, c.giocatore.valore);

        // Pre-state contratto
        const preContratto = {
          valido: true, tipo: c.tipo, durataContratto: c.durataContratto,
          giocatoreId: c.giocatoreId, fantaTeamId: c.fantaTeamId,
          importoOperazione: c.importoOperazione ? Number(c.importoOperazione) : 0,
        };

        // Invalida contratto
        await tx.contratto.update({
          where: { id: c.id },
          data:  { valido: false, destinazione: c.destinazione || "Scaduto" },
        });

        // SF target
        const presNome = c.fantaTeam.user ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email) : null;
        let sf = await tx.situazioneFinanziaria.findFirst({
          where: { fantaTeamId: c.fantaTeamId },
        });
        if (!sf && presNome) {
          sf = await tx.situazioneFinanziaria.findFirst({
            where: { nomePresidente: presNome },
          });
        }

        // Acquisto → SF update (Prestito non genera valore rosa)
        if (sf && c.tipo === "Acquisto") {
          const pre = {
            crediti:            Number(sf.crediti),
            valoreRose:         Number(sf.valoreRose),
            giocatoriTesserati: sf.giocatoriTesserati,
            stipendi:           Number(sf.stipendi),
          };
          const stipendioOld = c.importoOperazione ? Number(c.importoOperazione) : 0;
          const post = {
            crediti:            Math.round((pre.crediti    + quotValore) * 100) / 100,
            valoreRose:         Math.round((pre.valoreRose - quotValore) * 100) / 100,
            giocatoriTesserati: Math.max(0, pre.giocatoriTesserati - 1),
            stipendi:           Math.round((pre.stipendi   - stipendioOld) * 100) / 100,
          };
          await tx.situazioneFinanziaria.update({
            where: { id: sf.id },
            data:  post,
          });
          await tx.log.create({
            data: {
              azione:    "UPDATE",
              entita:    "situazione_finanziaria",
              entitaId:  sf.id,
              dettaglio: JSON.stringify({
                tipo: "fine-stagione-svincolo",
                contrattoId: c.id, giocatoreId: c.giocatoreId, giocatoreNome: c.giocatore.nome,
                fantaTeamId: c.fantaTeamId, quotazioneAccredito: quotValore,
                motivo: idsRejectedContrattoVecchio.has(c.id) ? "rinnovo-bocciato"
                       : idsDataFineScaduta.has(c.id) && c.durataContratto > 0 ? "scadenza-datafine"
                       : "scadenza-naturale",
                pre, post,
                rollbackSQL: sfRollbackSQL(sf.id, pre),
              }),
              adminId: ADMIN_ID,
            },
          });
        }

        // Elimina riga RosaGiocatore
        await tx.rosaGiocatore.deleteMany({
          where: { fantaTeamId: c.fantaTeamId, giocatoreId: c.giocatoreId },
        });

        // Log contratto
        await tx.log.create({
          data: {
            azione:    "UPDATE",
            entita:    "contratto",
            entitaId:  c.id,
            dettaglio: JSON.stringify({
              tipo:   "fine-stagione-svincolo",
              motivo: idsRejectedContrattoVecchio.has(c.id) ? "rinnovo-bocciato"
                     : idsDataFineScaduta.has(c.id) && c.durataContratto > 0 ? "scadenza-datafine"
                     : "scadenza-naturale",
              pre:    preContratto,
              post:   { valido: false, destinazione: c.destinazione || "Scaduto" },
            }),
            adminId: ADMIN_ID,
          },
        });

        // Update proposta status (se rejected per cap)
        if (idsRejectedContrattoVecchio.has(c.id)) {
          const rej = rejected.find((x) => x.proposta.contrattoId === c.id);
          if (rej) {
            await tx.propostaRinnovo.update({
              where: { id: rej.proposta.id },
              data: {
                status: "REJECTED",
                motivoStato: `Cap superato (ingaggio ${rej.ingaggio.toFixed(2)} M su quotazione ${rej.quotValore.toFixed(2)} M). Giocatore svincolato.`,
              },
            });
          }
        }

        svincoliApplicati++;
      }

      // ── Step 4: RINNOVI APPROVED ────────────────────────────────────────
      let rinnoviApplicati = 0;
      for (const ap of approved) {
        const p = ap.proposta;
        const quotValore = ap.quotValore;
        const ingaggio = ap.ingaggio;
        const prezzo = Math.round(quotValore * 100) / 100;

        const vecchio = await tx.contratto.findUnique({
          where:   { id: p.contrattoId },
          include: { giocatore: true, fantaTeam: { include: { user: true } } },
        });
        if (!vecchio) continue;

        const preVecchio = {
          id: vecchio.id, valido: true,
          durataContratto: vecchio.durataContratto, dataFine: vecchio.dataFine,
          importoOperazione: vecchio.importoOperazione ? Number(vecchio.importoOperazione) : 0,
          prezzoAcquisto: vecchio.prezzoAcquisto ? Number(vecchio.prezzoAcquisto) : null,
        };

        await tx.contratto.update({
          where: { id: vecchio.id },
          data:  { valido: false, destinazione: vecchio.destinazione || "Scaduto" },
        });

        const annoFine = annoCorrente + p.nuovaDurata;
        const dataFineNuovo = `${String(meseInizio).padStart(2, "0")}-${annoFine}`;
        const nuovo = await tx.contratto.create({
          data: {
            tipo:              "Acquisto",
            clausola:          null,
            dataStipula:       dataStipulaNuova,
            durataContratto:   p.nuovaDurata,
            dataFine:          dataFineNuovo,
            giocatoreId:       vecchio.giocatoreId,
            fantaTeamId:       vecchio.fantaTeamId,
            valoreGiocatore:   quotValore,
            importoOperazione: ingaggio,
            prezzoAcquisto:    prezzo,
            provenienza:       vecchio.provenienza,
            destinazione:      vecchio.destinazione,
            valido:            true,
          },
        });

        // Rollover RosaGiocatore → nessun cambio stagione necessario
        await tx.rosaGiocatore.updateMany({
          where: { fantaTeamId: vecchio.fantaTeamId, giocatoreId: vecchio.giocatoreId },
          data:  {},
        });

        await tx.propostaRinnovo.update({
          where: { id: p.id },
          data:  {
            status: "APPROVED",
            motivoStato: `Rinnovato a ${ingaggio.toFixed(2)} M (quot ${quotValore.toFixed(2)}, durata ${p.nuovaDurata}). Stipula ${dataStipulaNuova}, fine ${dataFineNuovo}.`,
          },
        });

        // Log contratto nuovo creato (pre = vecchio invalidato, post = nuovo)
        await tx.log.create({
          data: {
            azione:    "CREATE",
            entita:    "contratto",
            entitaId:  nuovo.id,
            dettaglio: JSON.stringify({
              tipo: "fine-stagione-rinnovo",
              propostaId: p.id,
              quotazione: quotValore,
              pre:  preVecchio,
              post: {
                id: nuovo.id, valido: true,
                tipo: "Acquisto", dataStipula: dataStipulaNuova,
                durataContratto: p.nuovaDurata, dataFine: dataFineNuovo,
                importoOperazione: ingaggio, prezzoAcquisto: prezzo,
                giocatoreId: nuovo.giocatoreId, fantaTeamId: nuovo.fantaTeamId,
              },
            }),
            adminId: ADMIN_ID,
          },
        });

        rinnoviApplicati++;
      }

      // Log batch riepilogativo
      await tx.log.create({
        data: {
          azione:    "UPDATE",
          entita:    "fine_stagione",
          entitaId:  null,
          dettaglio: JSON.stringify({
            tipo: "rollover-fine-stagione",
            stagioneOld, stagioneNew,
            dataEsecuzione: new Date().toISOString(),
            decrementoContratti: dec.count,
            svincoli: svincoliApplicati,
            rinnovi:  rinnoviApplicati,
            salaryCap: cap,
          }),
          adminId: ADMIN_ID,
        },
      });

      return {
        decrement:  dec.count,
        svincoli:   svincoliApplicati,
        rinnovi:    rinnoviApplicati,
        cap,
        stagioneOld, stagioneNew,
      };
    }, { timeout: 60_000 });

    res.redirect(`/admin/fine-stagione?ok=1&dec=${report.decrement}&svi=${report.svincoli}&rin=${report.rinnovi}`);
  } catch (err) {
    console.error("[fine-stagione] ERRORE:", err);
    res.redirect("/admin/fine-stagione?error=" + encodeURIComponent("Rollback eseguito: " + err.message));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP MANUALI (eseguibili singolarmente dalla pagina /admin/fine-stagione)
// Ogni step: una transazione a sé. Ordine libero (responsabilità dell'admin).
// Coppie preview/esegui: la preview ritorna solo cosa farebbe, senza scrivere.
// ═══════════════════════════════════════════════════════════════════════════

async function _buildCtx() {
  const params = await parametriService.getAll();
  const meseInizio = parseInt((params.stagione_inizio || "01-07").split("-")[1], 10) || 7;
  const sCorrente = stagioneCorrente(meseInizio);
  const stagioneOld = sCorrente.stagione;
  const stagioneNew = stagioneSuccessiva(stagioneOld);
  const annoCorrente = sCorrente.annoInizio + 1;
  const annoFineStagione = sCorrente.annoInizio + 1;
  const dataStipulaNuova = `${String(meseInizio).padStart(2, "0")}-${annoCorrente}`;
  return {
    params, meseInizio, stagioneOld, stagioneNew,
    annoCorrente, annoFineStagione, dataStipulaNuova,
    pctStipendio: parseFloat(params.stipendio_percentuale || "0.10"),
  };
}

async function _getDataFineFutura(client, annoFineStagione) {
  const tutti = await client.contratto.findMany({
    where: { valido: true },
    select: { id: true, dataFine: true },
  });
  return new Set(
    tutti
      .filter((c) => c.dataFine && /^\d{2}-\d{4}$/.test(c.dataFine)
        && parseInt(c.dataFine.split("-")[1], 10) > annoFineStagione)
      .map((c) => c.id)
  );
}

async function _getU21Keys(client) {
  const rows = await client.rosaGiocatore.findMany({
    where: { categoria: "U21" },
    select: { fantaTeamId: true, giocatoreId: true },
  });
  return new Set(rows.map((r) => `${r.fantaTeamId}:${r.giocatoreId}`));
}

function _jsonReply(res, ok, data, error) {
  res.json({ ok, ...(error ? { error } : {}), ...data });
}

// ── STEP 1 · Decremento durata ─────────────────────────────────────────────
async function _planStep1(client, ctx) {
  const idsFutura = await _getDataFineFutura(client, ctx.annoFineStagione);
  const candidati = await client.contratto.findMany({
    where: { valido: true, NOT: [{ id: { in: Array.from(idsFutura) } }] },
    select: { id: true, durataContratto: true, giocatoreId: true,
              fantaTeamId: true, dataFine: true,
              giocatore: { select: { nome: true } },
              fantaTeam: { select: { nome: true } } },
  });
  return { idsFutura, candidati };
}

async function previewStep1(req, res) {
  try {
    const ctx = await _buildCtx();
    const { idsFutura, candidati } = await _planStep1(prisma, ctx);
    const sample = candidati.slice(0, 30).map((c) => ({
      id: c.id, giocatore: c.giocatore?.nome, team: c.fantaTeam?.nome,
      durataPre: c.durataContratto, durataPost: c.durataContratto - 1,
      dataFine: c.dataFine,
    }));
    _jsonReply(res, true, {
      step: 1, descrizione: "Decremento durataContratto -= 1",
      stagioneOld: ctx.stagioneOld, stagioneNew: ctx.stagioneNew,
      contrattiDaDecrementare: candidati.length,
      contrattiProtettiDataFineFutura: idsFutura.size,
      anteprima: sample,
      anteprimaTroncata: candidati.length > sample.length,
    });
  } catch (e) { _jsonReply(res, false, { step: 1 }, e.message); }
}

async function eseguiStep1(req, res) {
  try {
    const ctx = await _buildCtx();
    const ADMIN_ID = req.user.id;
    const result = await prisma.$transaction(async (tx) => {
      const idsFutura = await _getDataFineFutura(tx, ctx.annoFineStagione);
      const dec = await tx.contratto.updateMany({
        where: { valido: true, NOT: [{ id: { in: Array.from(idsFutura) } }] },
        data:  { durataContratto: { decrement: 1 } },
      });
      await tx.log.create({
        data: {
          azione: "UPDATE", entita: "fine_stagione", entitaId: null,
          dettaglio: JSON.stringify({
            tipo: "fine-stagione-step1-decremento",
            stagioneOld: ctx.stagioneOld,
            contrattiDecrementati: dec.count,
            contrattiProtettiDataFineFutura: idsFutura.size,
            dataEsecuzione: new Date().toISOString(),
          }),
          adminId: ADMIN_ID,
        },
      });
      return { decrement: dec.count, protetti: idsFutura.size };
    }, { timeout: 60_000 });
    _jsonReply(res, true, { step: 1, ...result, messaggio: `Decrementati ${result.decrement} contratti.` });
  } catch (e) { _jsonReply(res, false, { step: 1 }, e.message); }
}

// ── STEP 2 · Decisione rinnovi (APPROVED / REJECTED in base a salary cap) ──
async function _planStep2(client, ctx) {
  const idsFutura = await _getDataFineFutura(client, ctx.annoFineStagione);
  const cap = await calcSalaryCapGlobale(client, ctx.params);
  const teams = await client.fantaTeam.findMany({ include: { user: true } });
  const decisioni = [];
  for (const team of teams) {
    const proposte = await client.propostaRinnovo.findMany({
      where: { fantaTeamId: team.id, status: "PENDING" },
      orderBy: { ordinePriorita: "asc" },
      include: { contratto: true, giocatore: true },
    });
    let speso = 0;
    for (const p of proposte) {
      if (idsFutura.has(p.contrattoId)) continue;
      const quotValore = await ultimaQuotazione(client, p.giocatoreId, p.giocatore.valore);
      const ingaggio = Math.round(quotValore * ctx.pctStipendio * 100) / 100;
      const cap1e9 = cap + 1e-9;
      const verdetto = (cap > 0 && speso + ingaggio <= cap1e9) ? "APPROVED" : "REJECTED";
      if (verdetto === "APPROVED") speso += ingaggio;
      decisioni.push({
        propostaId: p.id, teamId: team.id, teamNome: team.nome,
        giocatoreId: p.giocatoreId, giocatoreNome: p.giocatore.nome,
        contrattoId: p.contrattoId, nuovaDurata: p.nuovaDurata,
        quotValore, ingaggio, verdetto,
      });
    }
  }
  return { cap, decisioni };
}

async function previewStep2(req, res) {
  try {
    const ctx = await _buildCtx();
    const { cap, decisioni } = await _planStep2(prisma, ctx);
    _jsonReply(res, true, {
      step: 2, descrizione: "Decisione rinnovi: APPROVED/REJECTED su PropostaRinnovo (status)",
      stagioneNew: ctx.stagioneNew, salaryCap: cap,
      approved: decisioni.filter((d) => d.verdetto === "APPROVED").length,
      rejected: decisioni.filter((d) => d.verdetto === "REJECTED").length,
      decisioni,
    });
  } catch (e) { _jsonReply(res, false, { step: 2 }, e.message); }
}

async function eseguiStep2(req, res) {
  try {
    const ctx = await _buildCtx();
    const ADMIN_ID = req.user.id;
    const result = await prisma.$transaction(async (tx) => {
      const { cap, decisioni } = await _planStep2(tx, ctx);
      let approved = 0, rejected = 0;
      for (const d of decisioni) {
        if (d.verdetto === "APPROVED") {
          await tx.propostaRinnovo.update({
            where: { id: d.propostaId },
            data: {
              status: "APPROVED",
              motivoStato: `Approvato a ${d.ingaggio.toFixed(2)} M (quot ${d.quotValore.toFixed(2)}, durata ${d.nuovaDurata}). In attesa di stipula.`,
            },
          });
          approved++;
        } else {
          await tx.propostaRinnovo.update({
            where: { id: d.propostaId },
            data: {
              status: "REJECTED",
              motivoStato: `Cap superato (ingaggio ${d.ingaggio.toFixed(2)} M su quotazione ${d.quotValore.toFixed(2)} M).`,
            },
          });
          rejected++;
        }
      }
      await tx.log.create({
        data: {
          azione: "UPDATE", entita: "fine_stagione", entitaId: null,
          dettaglio: JSON.stringify({
            tipo: "fine-stagione-step2-decisione-rinnovi",
            stagioneNew: ctx.stagioneNew, salaryCap: cap,
            approved, rejected,
            dataEsecuzione: new Date().toISOString(),
          }),
          adminId: ADMIN_ID,
        },
      });
      return { approved, rejected, cap };
    }, { timeout: 60_000 });
    _jsonReply(res, true, { step: 2, ...result, messaggio: `Decisioni: ${result.approved} APPROVED · ${result.rejected} REJECTED (cap ${result.cap.toFixed(2)} M).` });
  } catch (e) { _jsonReply(res, false, { step: 2 }, e.message); }
}

// ── STEP 3 · Svincoli ──────────────────────────────────────────────────────
async function _planStep3(client, ctx) {
  const idsFutura = await _getDataFineFutura(client, ctx.annoFineStagione);
  const u21Keys = await _getU21Keys(client);

  // contratti vecchi rinnovati (saranno chiusi in step 4, NON svincolati)
  const approvedProposte = await client.propostaRinnovo.findMany({
    where: { status: "APPROVED" },
    select: { contrattoId: true },
  });
  const idsApproved = new Set(approvedProposte.map((p) => p.contrattoId));

  // contratti con proposta REJECTED (vanno svincolati)
  const rejectedProposte = await client.propostaRinnovo.findMany({
    where: { status: "REJECTED" },
    select: { contrattoId: true, id: true, motivoStato: true },
  });
  const idsRejected = new Set(rejectedProposte.map((p) => p.contrattoId));
  const rejectedById = new Map(rejectedProposte.map((p) => [p.contrattoId, p]));

  // Tutti validi non-rinnovati con dataFine scaduta per anno
  const tuttiValidi = await client.contratto.findMany({
    where: { valido: true, NOT: [{ id: { in: Array.from(idsApproved) } }] },
    select: { id: true, dataFine: true, fantaTeamId: true, giocatoreId: true },
  });
  const idsDataFineScaduta = new Set(
    tuttiValidi
      .filter((c) => {
        if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) return false;
        if (u21Keys.has(`${c.fantaTeamId}:${c.giocatoreId}`)) return false;
        return parseInt(c.dataFine.split("-")[1], 10) <= ctx.annoFineStagione;
      })
      .map((c) => c.id)
  );

  const candidati = await client.contratto.findMany({
    where: {
      valido: true,
      OR: [
        { durataContratto: { lte: 0 } },
        { id: { in: Array.from(idsRejected) } },
        { id: { in: Array.from(idsDataFineScaduta) } },
      ],
      NOT: [
        { id: { in: Array.from(idsApproved) } },
        { id: { in: Array.from(idsFutura) } },
      ],
    },
    include: { giocatore: true, fantaTeam: { include: { user: true } } },
  });
  // Filtra U21
  const filtrati = candidati.filter((c) => !u21Keys.has(`${c.fantaTeamId}:${c.giocatoreId}`));

  // Pre-calcola quotazione per ogni candidato (per preview)
  const enriched = [];
  for (const c of filtrati) {
    const quotValore = await ultimaQuotazione(client, c.giocatoreId, c.giocatore.valore);
    enriched.push({
      contrattoId: c.id, giocatoreId: c.giocatoreId, giocatoreNome: c.giocatore.nome,
      fantaTeamId: c.fantaTeamId, teamNome: c.fantaTeam.nome,
      tipo: c.tipo, durataContratto: c.durataContratto, dataFine: c.dataFine,
      stipendio: c.importoOperazione ? Number(c.importoOperazione) : 0,
      quotValore,
      motivo: idsRejected.has(c.id) ? "rinnovo-bocciato"
            : idsDataFineScaduta.has(c.id) && c.durataContratto > 0 ? "scadenza-datafine"
            : "scadenza-naturale",
    });
  }
  return { candidati: enriched, rejectedById };
}

async function previewStep3(req, res) {
  try {
    const ctx = await _buildCtx();
    const { candidati } = await _planStep3(prisma, ctx);
    _jsonReply(res, true, {
      step: 3, descrizione: "Svincoli: invalida contratto, accredita quotazione, scala SF, rimuove RosaGiocatore",
      stagioneOld: ctx.stagioneOld,
      svincoliPrevisti: candidati.length,
      candidati,
    });
  } catch (e) { _jsonReply(res, false, { step: 3 }, e.message); }
}

async function eseguiStep3(req, res) {
  try {
    const ctx = await _buildCtx();
    const ADMIN_ID = req.user.id;
    const result = await prisma.$transaction(async (tx) => {
      const { candidati, rejectedById } = await _planStep3(tx, ctx);
      let applicati = 0;
      for (const cand of candidati) {
        const c = await tx.contratto.findUnique({
          where: { id: cand.contrattoId },
          include: { fantaTeam: { include: { user: true } } },
        });
        if (!c || !c.valido) continue;

        const preContratto = {
          valido: true, tipo: c.tipo, durataContratto: c.durataContratto,
          giocatoreId: c.giocatoreId, fantaTeamId: c.fantaTeamId,
          importoOperazione: c.importoOperazione ? Number(c.importoOperazione) : 0,
        };

        await tx.contratto.update({
          where: { id: c.id },
          data: { valido: false, destinazione: c.destinazione || "Scaduto" },
        });

        // SF target
        const presNome = c.fantaTeam.user ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email) : null;
        let sf = await tx.situazioneFinanziaria.findFirst({
          where: { fantaTeamId: c.fantaTeamId },
        });
        if (!sf && presNome) {
          sf = await tx.situazioneFinanziaria.findFirst({
            where: { nomePresidente: presNome },
          });
        }

        if (sf && c.tipo === "Acquisto") {
          const sfFresh = await tx.situazioneFinanziaria.findUnique({ where: { id: sf.id } });
          const pre = {
            crediti: Number(sfFresh.crediti),
            valoreRose: Number(sfFresh.valoreRose),
            giocatoriTesserati: sfFresh.giocatoriTesserati,
            stipendi: Number(sfFresh.stipendi),
          };
          const post = {
            crediti:            Math.round((pre.crediti    + cand.quotValore) * 100) / 100,
            valoreRose:         Math.round((pre.valoreRose - cand.quotValore) * 100) / 100,
            giocatoriTesserati: Math.max(0, pre.giocatoriTesserati - 1),
            stipendi:           Math.round((pre.stipendi   - cand.stipendio) * 100) / 100,
          };
          await tx.situazioneFinanziaria.update({ where: { id: sf.id }, data: post });
          await tx.log.create({
            data: {
              azione: "UPDATE", entita: "situazione_finanziaria", entitaId: sf.id,
              dettaglio: JSON.stringify({
                tipo: "fine-stagione-step3-svincolo",
                contrattoId: c.id, giocatoreId: c.giocatoreId, giocatoreNome: cand.giocatoreNome,
                fantaTeamId: c.fantaTeamId, quotazioneAccredito: cand.quotValore,
                motivo: cand.motivo, pre, post,
                rollbackSQL: sfRollbackSQL(sf.id, pre),
              }),
              adminId: ADMIN_ID,
            },
          });
        }

        await tx.rosaGiocatore.deleteMany({
          where: { fantaTeamId: c.fantaTeamId, giocatoreId: c.giocatoreId },
        });

        await tx.log.create({
          data: {
            azione: "UPDATE", entita: "contratto", entitaId: c.id,
            dettaglio: JSON.stringify({
              tipo: "fine-stagione-step3-svincolo",
              motivo: cand.motivo, pre: preContratto,
              post: { valido: false, destinazione: c.destinazione || "Scaduto" },
            }),
            adminId: ADMIN_ID,
          },
        });

        applicati++;
      }
      await tx.log.create({
        data: {
          azione: "UPDATE", entita: "fine_stagione", entitaId: null,
          dettaglio: JSON.stringify({
            tipo: "fine-stagione-step3-svincoli-batch",
            stagioneOld: ctx.stagioneOld, svincoli: applicati,
            dataEsecuzione: new Date().toISOString(),
          }),
          adminId: ADMIN_ID,
        },
      });
      return { svincoli: applicati };
    }, { timeout: 60_000 });
    _jsonReply(res, true, { step: 3, ...result, messaggio: `Svincoli applicati: ${result.svincoli}.` });
  } catch (e) { _jsonReply(res, false, { step: 3 }, e.message); }
}

// ── STEP 4 · Rinnovi APPROVED → crea nuovi contratti ───────────────────────
async function _planStep4(client, ctx) {
  const proposte = await client.propostaRinnovo.findMany({
    where: { status: "APPROVED" },
    include: { contratto: { include: { giocatore: true, fantaTeam: true } }, giocatore: true },
  });
  // Solo proposte con contratto vecchio ancora valido (non già processate)
  const rinnovabili = proposte.filter((p) => p.contratto && p.contratto.valido);
  const enriched = [];
  for (const p of rinnovabili) {
    const quotValore = await ultimaQuotazione(client, p.giocatoreId, p.giocatore.valore);
    const ingaggio = Math.round(quotValore * ctx.pctStipendio * 100) / 100;
    const prezzo = Math.round(quotValore * 100) / 100;
    const annoFine = ctx.annoCorrente + p.nuovaDurata;
    const dataFineNuovo = `${String(ctx.meseInizio).padStart(2, "0")}-${annoFine}`;
    enriched.push({
      propostaId: p.id, contrattoVecchioId: p.contrattoId,
      giocatoreId: p.giocatoreId, giocatoreNome: p.giocatore.nome,
      teamNome: p.contratto.fantaTeam?.nome,
      nuovaDurata: p.nuovaDurata,
      quotValore, ingaggio, prezzo,
      dataStipula: ctx.dataStipulaNuova, dataFine: dataFineNuovo,
    });
  }
  return { rinnovi: enriched };
}

async function previewStep4(req, res) {
  try {
    const ctx = await _buildCtx();
    const { rinnovi } = await _planStep4(prisma, ctx);
    _jsonReply(res, true, {
      step: 4, descrizione: "Rinnovi APPROVED: chiude contratto vecchio + crea nuovo + sposta rosa",
      stagioneOld: ctx.stagioneOld, stagioneNew: ctx.stagioneNew,
      rinnoviPrevisti: rinnovi.length,
      rinnovi,
    });
  } catch (e) { _jsonReply(res, false, { step: 4 }, e.message); }
}

async function eseguiStep4(req, res) {
  try {
    const ctx = await _buildCtx();
    const ADMIN_ID = req.user.id;
    const result = await prisma.$transaction(async (tx) => {
      const { rinnovi } = await _planStep4(tx, ctx);
      let applicati = 0;
      for (const r of rinnovi) {
        const vecchio = await tx.contratto.findUnique({
          where: { id: r.contrattoVecchioId },
          include: { giocatore: true, fantaTeam: { include: { user: true } } },
        });
        if (!vecchio || !vecchio.valido) continue;

        const preVecchio = {
          id: vecchio.id, valido: true,
          durataContratto: vecchio.durataContratto, dataFine: vecchio.dataFine,
          importoOperazione: vecchio.importoOperazione ? Number(vecchio.importoOperazione) : 0,
          prezzoAcquisto: vecchio.prezzoAcquisto ? Number(vecchio.prezzoAcquisto) : null,
        };

        await tx.contratto.update({
          where: { id: vecchio.id },
          data: { valido: false, destinazione: vecchio.destinazione || "Scaduto" },
        });

        const nuovo = await tx.contratto.create({
          data: {
            tipo: "Acquisto", clausola: null,
            dataStipula: r.dataStipula,
            durataContratto: r.nuovaDurata,
            dataFine: r.dataFine,
            giocatoreId: vecchio.giocatoreId,
            fantaTeamId: vecchio.fantaTeamId,
            valoreGiocatore: r.quotValore,
            importoOperazione: r.ingaggio,
            prezzoAcquisto: r.prezzo,
            provenienza: vecchio.provenienza,
            destinazione: vecchio.destinazione,
            valido: true,
          },
        });

        await tx.rosaGiocatore.updateMany({
          where: { fantaTeamId: vecchio.fantaTeamId, giocatoreId: vecchio.giocatoreId },
          data: {},
        });

        await tx.propostaRinnovo.update({
          where: { id: r.propostaId },
          data: {
            motivoStato: `Rinnovato a ${r.ingaggio.toFixed(2)} M (quot ${r.quotValore.toFixed(2)}, durata ${r.nuovaDurata}). Stipula ${r.dataStipula}, fine ${r.dataFine}.`,
          },
        });

        await tx.log.create({
          data: {
            azione: "CREATE", entita: "contratto", entitaId: nuovo.id,
            dettaglio: JSON.stringify({
              tipo: "fine-stagione-step4-rinnovo",
              propostaId: r.propostaId, quotazione: r.quotValore,
              pre: preVecchio,
              post: {
                id: nuovo.id, valido: true, tipo: "Acquisto",
                dataStipula: r.dataStipula, durataContratto: r.nuovaDurata, dataFine: r.dataFine,
                importoOperazione: r.ingaggio, prezzoAcquisto: r.prezzo,
                giocatoreId: nuovo.giocatoreId, fantaTeamId: nuovo.fantaTeamId,
              },
            }),
            adminId: ADMIN_ID,
          },
        });
        applicati++;
      }
      await tx.log.create({
        data: {
          azione: "UPDATE", entita: "fine_stagione", entitaId: null,
          dettaglio: JSON.stringify({
            tipo: "fine-stagione-step4-rinnovi-batch",
            stagioneOld: ctx.stagioneOld, stagioneNew: ctx.stagioneNew,
            rinnovi: applicati,
            dataEsecuzione: new Date().toISOString(),
          }),
          adminId: ADMIN_ID,
        },
      });
      return { rinnovi: applicati };
    }, { timeout: 60_000 });
    _jsonReply(res, true, { step: 4, ...result, messaggio: `Rinnovi applicati: ${result.rinnovi}.` });
  } catch (e) { _jsonReply(res, false, { step: 4 }, e.message); }
}

// ── STEP 2B · Stipendi pluriennali (addebito annuale + riallineamento invernali) ──
//
// Cosa fa: addebita lo stipendio annuale dei contratti che continueranno nella
// stagione nuova (dataFine.anno > annoFineStagione) e, per i contratti firmati
// in sessione invernale che vivranno il loro primo rollover (dataStipula
// inizia per "01-" AND anno == annoFineStagione), raddoppia importoOperazione
// per allinearlo dal 5% al 10%, addebitando lo stipendio pieno.
//
// Esclusi: i contratti vecchi delle proposte APPROVED (li chiude Step 4, che
// crea il nuovo contratto e — in finalizzaRinnovi — addebita l'ingaggio nuovo).
// U21 partecipano normalmente.
// Capienza: NON bloccante. I team con saldo negativo finale finiscono nel
// warning del report.
async function _planStep2B(client, ctx) {
  const approvedProposte = await client.propostaRinnovo.findMany({
    where: { status: "APPROVED" },
    select: { contrattoId: true },
  });
  const idsApproved = new Set(approvedProposte.map((p) => p.contrattoId));

  const candidati = await client.contratto.findMany({
    where: {
      valido: true,
      tipo:   "Acquisto",
      NOT:    [{ id: { in: Array.from(idsApproved) } }],
    },
    include: {
      giocatore: { select: { id: true, nome: true } },
      fantaTeam: { include: { user: true } },
    },
  });

  const enriched = [];
  for (const c of candidati) {
    if (!c.dataFine || !/^\d{2}-\d{4}$/.test(c.dataFine)) continue;
    const annoFine = parseInt(c.dataFine.split("-")[1], 10);
    if (annoFine <= ctx.annoFineStagione) continue; // svincolo, gestito da Step 3

    const stipendioAttuale = c.importoOperazione ? Number(c.importoOperazione) : 0;
    const isInvernale = typeof c.dataStipula === "string"
      && c.dataStipula.startsWith("01-")
      && parseInt(c.dataStipula.split("-")[1], 10) === ctx.annoFineStagione;
    const stipendioAddebito = isInvernale
      ? Math.round(stipendioAttuale * 2 * 100) / 100
      : stipendioAttuale;

    enriched.push({
      contrattoId: c.id,
      giocatoreId: c.giocatoreId,
      giocatoreNome: c.giocatore.nome,
      fantaTeamId: c.fantaTeamId,
      teamNome: c.fantaTeam.nome,
      presNome: c.fantaTeam.user ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email) : null,
      dataStipula: c.dataStipula,
      dataFine: c.dataFine,
      stipendioAttuale,
      stipendioAddebito,
      riallineamentoInvernale: isInvernale,
    });
  }

  // Aggrega per team per il warning capienza
  const aggregatoPerTeam = {};
  for (const e of enriched) {
    const k = e.fantaTeamId;
    if (!aggregatoPerTeam[k]) aggregatoPerTeam[k] = { fantaTeamId: k, teamNome: e.teamNome, presNome: e.presNome, totaleAddebito: 0, contratti: 0, riallineati: 0 };
    aggregatoPerTeam[k].totaleAddebito = Math.round((aggregatoPerTeam[k].totaleAddebito + e.stipendioAddebito) * 100) / 100;
    aggregatoPerTeam[k].contratti += 1;
    if (e.riallineamentoInvernale) aggregatoPerTeam[k].riallineati += 1;
  }
  const totals = Object.values(aggregatoPerTeam);
  return { candidati: enriched, perTeam: totals };
}

async function previewStep2B(req, res) {
  try {
    const ctx = await _buildCtx();
    const { candidati, perTeam } = await _planStep2B(prisma, ctx);

    // Simula impatto sul saldo per warning capienza
    const warnings = [];
    for (const t of perTeam) {
      let sf = await prisma.situazioneFinanziaria.findFirst({
        where: { fantaTeamId: t.fantaTeamId },
      });
      if (!sf && t.presNome) {
        sf = await prisma.situazioneFinanziaria.findFirst({
          where: { nomePresidente: t.presNome },
        });
      }
      const creditiPre = sf ? Number(sf.crediti) : null;
      const creditiPost = creditiPre != null ? Math.round((creditiPre - t.totaleAddebito) * 100) / 100 : null;
      t.sfId = sf?.id ?? null;
      t.creditiPre = creditiPre;
      t.creditiPost = creditiPost;
      if (creditiPost != null && creditiPost < 0) {
        warnings.push({
          fantaTeamId: t.fantaTeamId, teamNome: t.teamNome,
          creditiPre, totaleAddebito: t.totaleAddebito, creditiPost,
        });
      }
    }

    _jsonReply(res, true, {
      step: "2B",
      descrizione: "Stipendi pluriennali: addebito annuale + riallineamento invernali (5%→10%)",
      stagioneOld: ctx.stagioneOld, stagioneNew: ctx.stagioneNew,
      contrattiTotali: candidati.length,
      riallineamentiInvernali: candidati.filter((x) => x.riallineamentoInvernale).length,
      totaleAddebito: Math.round(candidati.reduce((s, x) => s + x.stipendioAddebito, 0) * 100) / 100,
      warningsCapienza: warnings,
      perTeam,
      candidati,
    });
  } catch (e) { _jsonReply(res, false, { step: "2B" }, e.message); }
}

async function eseguiStep2B(req, res) {
  try {
    const ctx = await _buildCtx();
    const ADMIN_ID = req.user.id;
    const batchId = `step2b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await prisma.$transaction(async (tx) => {
      const { candidati } = await _planStep2B(tx, ctx);
      const dettagliOk = [];
      const warningsCapienza = [];

      for (const cand of candidati) {
        // Trova SF target
        let sf = await tx.situazioneFinanziaria.findFirst({
          where: { fantaTeamId: cand.fantaTeamId },
        });
        if (!sf && cand.presNome) {
          sf = await tx.situazioneFinanziaria.findFirst({
            where: { nomePresidente: cand.presNome },
          });
        }
        if (!sf) {
          throw new Error(`SF non trovata per fantaTeamId=${cand.fantaTeamId} (contratto #${cand.contrattoId}).`);
        }

        // 1) Riallineamento contratto invernale (con log dedicato per rollback)
        let contrattoLogId = null;
        if (cand.riallineamentoInvernale) {
          await tx.contratto.update({
            where: { id: cand.contrattoId },
            data:  { importoOperazione: cand.stipendioAddebito },
          });
          const contrattoLog = await tx.log.create({
            data: {
              azione: "UPDATE", entita: "contratto", entitaId: cand.contrattoId,
              dettaglio: JSON.stringify({
                tipo: "fine-stagione-step2B-riallineamento-invernale",
                batchId, stagioneOld: ctx.stagioneOld,
                prima: { importoOperazione: cand.stipendioAttuale },
                dopo:  { importoOperazione: cand.stipendioAddebito },
                giocatoreId: cand.giocatoreId, giocatoreNome: cand.giocatoreNome,
                fantaTeamId: cand.fantaTeamId, teamNome: cand.teamNome,
              }),
              adminId: ADMIN_ID,
            },
          });
          contrattoLogId = contrattoLog.id;
        }

        // 2) Addebito stipendio (NO check capienza, warning gestito a parte)
        const mov = await modificaCreditiTeam(tx, {
          sfId: sf.id,
          fantaTeamId: cand.fantaTeamId,
          deltaCrediti:  -cand.stipendioAddebito,
          deltaStipendi: 0,   // gli stipendi annuali della rosa restano come somma dei contratti
          causale: CAUSALI.PAGAMENTO_STIPENDIO_PLURIENNALE,
          contesto: {
            batchId,
            step: "2B",
            contrattoId: cand.contrattoId,
            giocatoreId: cand.giocatoreId,
            giocatoreNome: cand.giocatoreNome,
            riallineamento_invernale: cand.riallineamentoInvernale,
            contrattoLogId,
            stipendioAttuale: cand.stipendioAttuale,
            stipendioAddebito: cand.stipendioAddebito,
            dataStipula: cand.dataStipula,
            dataFine: cand.dataFine,
          },
          adminId: ADMIN_ID,
          checkCapienza: false,
        });

        dettagliOk.push({
          contrattoId: cand.contrattoId,
          giocatoreNome: cand.giocatoreNome,
          teamNome: cand.teamNome,
          stipendioAddebito: cand.stipendioAddebito,
          riallineamentoInvernale: cand.riallineamentoInvernale,
          movimentoId: mov.movimento.id,
          movimentoLogId: mov.log.id,
          contrattoLogId,
          creditiPre: mov.pre.crediti,
          creditiPost: mov.post.crediti,
        });

        if (mov.post.crediti < 0) {
          warningsCapienza.push({
            fantaTeamId: cand.fantaTeamId, teamNome: cand.teamNome,
            creditiPre: mov.pre.crediti, addebito: cand.stipendioAddebito,
            creditiPost: mov.post.crediti, contrattoId: cand.contrattoId,
          });
        }
      }

      // Log batch riepilogativo
      await tx.log.create({
        data: {
          azione: "UPDATE", entita: "fine_stagione", entitaId: null,
          dettaglio: JSON.stringify({
            tipo: "fine-stagione-step2B-stipendi-pluriennali-batch",
            batchId, stagioneOld: ctx.stagioneOld,
            contratti: dettagliOk.length,
            riallineamentiInvernali: dettagliOk.filter((x) => x.riallineamentoInvernale).length,
            totaleAddebito: Math.round(dettagliOk.reduce((s, x) => s + x.stipendioAddebito, 0) * 100) / 100,
            warningsCapienza,
            dataEsecuzione: new Date().toISOString(),
          }),
          adminId: ADMIN_ID,
        },
      });

      return { batchId, contratti: dettagliOk.length, riallineamenti: dettagliOk.filter((x) => x.riallineamentoInvernale).length, warningsCapienza, dettagli: dettagliOk };
    }, { timeout: 90_000 });

    _jsonReply(res, true, {
      step: "2B", ...result,
      messaggio: `Step 2B applicato: ${result.contratti} contratti, ${result.riallineamenti} riallineamenti invernali, ${result.warningsCapienza.length} team in rosso. batchId=${result.batchId}.`,
    });
  } catch (e) { _jsonReply(res, false, { step: "2B" }, e.message); }
}

// ── STEP 2B · Annulla intero batch ────────────────────────────────────────
// Ripristina tutti i contratti riallineati al loro importoOperazione precedente,
// stoma gli addebiti su SF, cancella le righe MovimentoFinanziario del batch e
// marca rollbacked=true i log coinvolti.
async function annullaStep2B(req, res) {
  try {
    const batchId = String(req.body?.batchId || req.query?.batchId || "").trim();
    if (!batchId) return _jsonReply(res, false, {}, "batchId obbligatorio.");
    const ADMIN_ID = req.user.id;

    const result = await prisma.$transaction(async (tx) => {
      const allLog = await tx.log.findMany({
        where: { entita: { in: ["movimento_finanziario", "contratto", "fine_stagione"] } },
        orderBy: { id: "asc" },
      });

      const logsBatch = allLog
        .map((l) => {
          try { return { ...l, _det: JSON.parse(l.dettaglio || "{}") }; }
          catch { return null; }
        })
        .filter((l) => {
          if (!l) return false;
          const det = l._det;
          if (det.batchId === batchId) return true;
          if (det.contesto?.batchId === batchId) return true;
          try {
            const ctxStr = typeof det.contesto === "string" ? det.contesto : null;
            if (ctxStr && ctxStr.includes(batchId)) return true;
          } catch { /* noop */ }
          return false;
        });

      if (logsBatch.length === 0) {
        throw new Error(`Nessun log trovato per batchId=${batchId}.`);
      }

      let movimentiRollback = 0;
      let contrattiRollback = 0;
      let batchRollback = 0;

      for (const l of logsBatch) {
        if (l.rollbacked) continue;
        const det = l._det;

        if (l.entita === "movimento_finanziario") {
          // Cerca il movimento collegato (per logId)
          const movimento = await tx.movimentoFinanziario.findFirst({ where: { logId: l.id } });
          if (movimento) {
            // Ripristina SF allo stato `pre`
            if (det.pre && det.sfId) {
              await tx.situazioneFinanziaria.update({
                where: { id: det.sfId },
                data:  { crediti: det.pre.crediti, stipendi: det.pre.stipendi, patrimonio: det.pre.patrimonio },
              });
            }
            await tx.movimentoFinanziario.delete({ where: { id: movimento.id } });
          }
          await tx.log.update({ where: { id: l.id }, data: { rollbacked: true } });
          movimentiRollback++;
        } else if (l.entita === "contratto" && det.tipo === "fine-stagione-step2B-riallineamento-invernale") {
          if (det.prima?.importoOperazione != null && l.entitaId) {
            await tx.contratto.update({
              where: { id: l.entitaId },
              data:  { importoOperazione: det.prima.importoOperazione },
            });
          }
          await tx.log.update({ where: { id: l.id }, data: { rollbacked: true } });
          contrattiRollback++;
        } else if (l.entita === "fine_stagione" && det.tipo === "fine-stagione-step2B-stipendi-pluriennali-batch") {
          await tx.log.update({ where: { id: l.id }, data: { rollbacked: true } });
          batchRollback++;
        }
      }

      await tx.log.create({
        data: {
          azione: "UPDATE", entita: "fine_stagione", entitaId: null,
          dettaglio: JSON.stringify({
            tipo: "fine-stagione-step2B-annulla-batch",
            batchId, movimentiRollback, contrattiRollback, batchRollback,
            dataEsecuzione: new Date().toISOString(),
          }),
          adminId: ADMIN_ID,
        },
      });

      return { batchId, movimentiRollback, contrattiRollback, batchRollback };
    }, { timeout: 90_000 });

    _jsonReply(res, true, { step: "2B", azione: "annulla", ...result,
      messaggio: `Annullato batch ${batchId}: ${result.movimentiRollback} addebiti stornati, ${result.contrattiRollback} contratti ripristinati.` });
  } catch (e) { _jsonReply(res, false, { step: "2B", azione: "annulla" }, e.message); }
}

module.exports = {
  showFineStagione, eseguiFineStagione,
  previewStep1, eseguiStep1,
  previewStep2, eseguiStep2,
  previewStep2B, eseguiStep2B, annullaStep2B,
  previewStep3, eseguiStep3,
  previewStep4, eseguiStep4,
};
