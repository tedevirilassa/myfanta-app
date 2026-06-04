// src/controllers/fine-stagione.controller.js
// Job di rollover fine stagione (30 giugno). Eseguito in unica transazione
// ACID: se qualsiasi step fallisce → ROLLBACK totale.

const prisma = require("../lib/prisma");
const parametriService = require("../services/parametri.service");

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

async function calcSalaryCapGlobale(tx) {
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
  return Math.round(((maxR + minR) / 2) * 0.25 * 0.10 * 100) / 100;
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
    where: { stagione: stagioneNew, status: "PENDING" },
  });
  const scadenzeNaturali = await prisma.contratto.count({
    where: { valido: true, durataContratto: { lte: 1 } }, // scenderanno a 0
  });

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
//  1. Decrement durataContratto su tutti i contratti validi.
//  2. Simula rinnovi: marca proposte APPROVED/REJECTED in base a cap.
//  3. Svincoli: contratti scaduti (durata≤0) E non rinnovati, + proposte REJECTED.
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
      // ── Step 1: Decremento Temporale ─────────────────────────────────────
      const dec = await tx.contratto.updateMany({
        where: { valido: true },
        data:  { durataContratto: { decrement: 1 } },
      });

      // ── Step 2: Simula rinnovi → APPROVED / REJECTED ──────────────────
      const cap = await calcSalaryCapGlobale(tx);
      const teams = await tx.fantaTeam.findMany({ include: { user: true } });
      const approved = [];
      const rejected = [];

      for (const team of teams) {
        const proposte = await tx.propostaRinnovo.findMany({
          where:   { fantaTeamId: team.id, stagione: stagioneNew, status: "PENDING" },
          orderBy: { ordinePriorita: "asc" },
          include: { contratto: true, giocatore: true },
        });
        let speso = 0;
        for (const p of proposte) {
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
      const candidatiSvincolo = await tx.contratto.findMany({
        where: {
          valido: true,
          OR: [
            { durataContratto: { lte: 0 } },
            { id: { in: Array.from(idsRejectedContrattoVecchio) } },
          ],
          NOT: [
            // Esclude i contratti rinnovati (verranno chiusi nel passo Rinnovi)
            { id: { in: Array.from(idsApprovedContrattoVecchio) } },
          ],
        },
        include: { giocatore: true, fantaTeam: { include: { user: true } } },
      });

      let svincoliApplicati = 0;
      for (const c of candidatiSvincolo) {
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

        // SF target (stagione vecchia)
        const presNome = c.fantaTeam.user ? (c.fantaTeam.user.nickname || c.fantaTeam.user.email) : null;
        let sf = await tx.situazioneFinanziaria.findFirst({
          where: { fantaTeamId: c.fantaTeamId, stagione: stagioneOld },
        });
        if (!sf && presNome) {
          sf = await tx.situazioneFinanziaria.findFirst({
            where: { nomePresidente: presNome, stagione: stagioneOld },
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
                motivo: idsRejectedContrattoVecchio.has(c.id) ? "rinnovo-bocciato" : "scadenza-naturale",
                pre, post,
              }),
              adminId: ADMIN_ID,
            },
          });
        }

        // Elimina riga RosaGiocatore stagione vecchia
        await tx.rosaGiocatore.deleteMany({
          where: { fantaTeamId: c.fantaTeamId, giocatoreId: c.giocatoreId, stagione: stagioneOld },
        });

        // Log contratto
        await tx.log.create({
          data: {
            azione:    "UPDATE",
            entita:    "contratto",
            entitaId:  c.id,
            dettaglio: JSON.stringify({
              tipo:   "fine-stagione-svincolo",
              motivo: idsRejectedContrattoVecchio.has(c.id) ? "rinnovo-bocciato" : "scadenza-naturale",
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

        // Rollover RosaGiocatore → stagione successiva
        await tx.rosaGiocatore.updateMany({
          where: { fantaTeamId: vecchio.fantaTeamId, giocatoreId: vecchio.giocatoreId, stagione: stagioneOld },
          data:  { stagione: stagioneNew },
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

module.exports = { showFineStagione, eseguiFineStagione };
