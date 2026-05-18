"use strict";
// scripts/test-contratto-annulla.js
// End-to-end test: stipula nuovo contratto via saveNuovoContratto, poi annulla via
// annullaContratto, e verifica che lo stato post-annullamento sia identico al
// pre-stipula.
//
// Run: node scripts/test-contratto-annulla.js
//
// NB: tocca DB reale. Se l'annullamento funziona, lo stato torna identico → nessuna
// pulizia richiesta. Se fallisce, lo script stampa le differenze residue.

require("dotenv").config();

const prisma = require("../src/lib/prisma");
const ctrl   = require("../src/controllers/admin.controller");

function fmt(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object" && v.toString) {
    // Decimal-like
    const s = v.toString();
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    return JSON.stringify(v);
  }
  return String(v);
}

async function snapshotState({ giocatoreId, buyerSfId, sellerSfId }) {
  const [contratti, sfBuyer, sfSeller, giocatore] = await Promise.all([
    prisma.contratto.findMany({
      where:   { giocatoreId },
      select:  { id: true, tipo: true, valido: true, dataStipula: true, fantaTeamId: true, prezzoAcquisto: true, importoOperazione: true, valoreGiocatore: true, provenienza: true, createdAt: true },
      orderBy: { id: "asc" },
    }),
    buyerSfId  ? prisma.situazioneFinanziaria.findUnique({ where: { id: buyerSfId }})  : Promise.resolve(null),
    sellerSfId ? prisma.situazioneFinanziaria.findUnique({ where: { id: sellerSfId }}) : Promise.resolve(null),
    prisma.giocatore.findUnique({ where: { id: giocatoreId }, select: { id: true, active: true, nome: true, squadra: true, valore: true } }),
  ]);

  return {
    contratti: contratti.map(c => ({
      id:               c.id,
      tipo:             c.tipo,
      valido:           c.valido,
      dataStipula:      c.dataStipula,
      fantaTeamId:      c.fantaTeamId,
      prezzoAcquisto:   c.prezzoAcquisto    ? c.prezzoAcquisto.toString()    : null,
      importoOperazione:c.importoOperazione ? c.importoOperazione.toString() : null,
      valoreGiocatore:  c.valoreGiocatore   ? c.valoreGiocatore.toString()   : null,
      provenienza:      c.provenienza,
    })),
    sfBuyer: sfBuyer ? {
      id:         sfBuyer.id,
      crediti:    sfBuyer.crediti.toString(),
      patrimonio: sfBuyer.patrimonio.toString(),
      stipendi:   sfBuyer.stipendi.toString(),
    } : null,
    sfSeller: sfSeller ? {
      id:         sfSeller.id,
      crediti:    sfSeller.crediti.toString(),
      patrimonio: sfSeller.patrimonio.toString(),
      stipendi:   sfSeller.stipendi.toString(),
    } : null,
    giocatore: giocatore ? {
      id: giocatore.id, active: giocatore.active, nome: giocatore.nome, squadra: giocatore.squadra,
      valore: giocatore.valore ? giocatore.valore.toString() : null,
    } : null,
  };
}

function diffSnapshots(pre, post) {
  const diffs = [];
  // contratti diff
  const preById  = new Map(pre.contratti.map(c => [c.id, c]));
  const postById = new Map(post.contratti.map(c => [c.id, c]));
  for (const [id, c] of preById) {
    if (!postById.has(id)) diffs.push(`contratto ${id}: presente prima, assente dopo`);
    else {
      const p = postById.get(id);
      for (const k of Object.keys(c)) {
        if (fmt(c[k]) !== fmt(p[k])) diffs.push(`contratto ${id}.${k}: pre=${fmt(c[k])} post=${fmt(p[k])}`);
      }
    }
  }
  for (const [id] of postById) {
    if (!preById.has(id)) diffs.push(`contratto ${id}: assente prima, presente dopo (LEAK)`);
  }
  // sf diff
  for (const side of ["sfBuyer", "sfSeller"]) {
    const a = pre[side], b = post[side];
    if (!a && !b) continue;
    if (!a || !b) { diffs.push(`${side}: existence mismatch`); continue; }
    for (const k of ["crediti", "patrimonio", "stipendi"]) {
      if (fmt(a[k]) !== fmt(b[k])) diffs.push(`${side}.${k}: pre=${fmt(a[k])} post=${fmt(b[k])}`);
    }
  }
  // giocatore diff
  if (pre.giocatore && post.giocatore) {
    for (const k of ["active", "squadra", "valore"]) {
      if (fmt(pre.giocatore[k]) !== fmt(post.giocatore[k])) {
        diffs.push(`giocatore.${k}: pre=${fmt(pre.giocatore[k])} post=${fmt(post.giocatore[k])}`);
      }
    }
  }
  return diffs;
}

function mockResp(label) {
  const calls = { redirects: [], renders: [] };
  return {
    res: {
      redirect: (url) => { calls.redirects.push(url); console.log(`[${label}] res.redirect →`, url); },
      render:   (view, data) => { calls.renders.push({ view, error: data && data.error }); console.log(`[${label}] res.render →`, view, "error:", data && data.error); },
      status:   () => ({ json: (j) => { console.log(`[${label}] res.json →`, j); } }),
    },
    calls,
  };
}

async function testScenarioPrivato(admin) {
  console.log("\n\n══════════ TEST 2 — ACQUISTO PRIVATO + ANNULLAMENTO ══════════\n");

  // Trova un giocatore con contratto Acquisto valido (sarà il giocatore di A)
  // Filtra contratti il cui fantaTeam ha un user associato (userId not null).
  const contrattoA = await prisma.contratto.findFirst({
    where: {
      tipo:              "Acquisto",
      valido:            true,
      importoOperazione: { not: null },
      fantaTeam:         { userId: { not: null } },
      giocatore:         { valore: { not: null } },
    },
    orderBy: { createdAt: "desc" },
    include: { fantaTeam: { include: { user: true } }, giocatore: { select: { id: true, nome: true, valore: true } } },
  });
  if (!contrattoA) { console.log("Skipping: nessun contratto Acquisto valido con user+valore."); return; }
  const sellerUser = contrattoA.fantaTeam.user;
  const presidenteA = sellerUser.nickname || sellerUser.email;
  console.log("Venditore A:", presidenteA, "contratto id=", contrattoA.id, "giocatore=", contrattoA.giocatore.nome);

  const sfSeller = await prisma.situazioneFinanziaria.findFirst({
    where: { nomePresidente: presidenteA, stagione: "2025-2026" },
  });
  if (!sfSeller) { console.log("Skipping: SF venditore 2025-2026 mancante."); return; }

  // Acquirente B: presidente diverso da A, con user che possiede un fantaTeam.
  const sfCandidates = await prisma.situazioneFinanziaria.findMany({
    where:   { stagione: "2025-2026", NOT: { id: sfSeller.id } },
    orderBy: { id: "asc" },
  });
  let sfBuyer = null, buyerUser = null;
  for (const cand of sfCandidates) {
    const u = await prisma.user.findFirst({
      where:   { OR: [{ nickname: cand.nomePresidente }, { email: cand.nomePresidente }], isActive: true },
      include: { fantaTeam: true },
    });
    if (u && u.fantaTeam) { sfBuyer = cand; buyerUser = u; break; }
  }
  if (!sfBuyer || !buyerUser) { console.log("Skipping: nessun acquirente con fantaTeam."); return; }
  console.log("Acquirente B:", sfBuyer.nomePresidente, "sfId=", sfBuyer.id);

  const giocatoreId = contrattoA.giocatore.id;
  const valoreTM    = contrattoA.giocatore.valore ? parseFloat(contrattoA.giocatore.valore.toString()) : 1;
  const prezzo      = Math.round(valoreTM * 1.0 * 10) / 10;
  console.log("Giocatore:", contrattoA.giocatore.nome, "valore=", valoreTM, "prezzo=", prezzo);

  // Snapshot pre-stipula
  const stateBefore = await snapshotState({
    giocatoreId,
    buyerSfId:  sfBuyer.id,
    sellerSfId: sfSeller.id,
  });
  console.log("\n── PRE-STIPULA ─────────");
  console.log("contratti per giocatore:", stateBefore.contratti.length, "(prev=", contrattoA.id, "valido=", contrattoA.valido, ")");
  console.log("buyer  crediti=", stateBefore.sfBuyer.crediti, "stipendi=", stateBefore.sfBuyer.stipendi);
  console.log("seller crediti=", stateBefore.sfSeller.crediti, "stipendi=", stateBefore.sfSeller.stipendi);

  // saveNuovoContratto: stessa sessione del contratto A per testare storno 100%
  const mmA = parseInt((contrattoA.dataStipula || "").slice(0, 2), 10);
  const sessioneA = mmA === 1 ? "Invernale" : "Estiva";
  const dataStipulaB = sessioneA === "Invernale" ? "01-2026" : "07-2025";

  const reqSave = {
    user:   { id: admin.id, role: "ADMIN" },
    params: {}, query: {},
    body: {
      tipo: "Acquisto", clausola: "",
      sessione: sessioneA, dataStipula: dataStipulaB, durataContratto: "2",
      giocatoreId: String(giocatoreId), fantaPresidenteId: String(buyerUser.id),
      prezzoAcquisto: String(prezzo), importoOperazione: "",
      provenienza: presidenteA, // privato: nome del cedente
      destinazione: "",
    },
  };
  const respSave = mockResp("SAVE2");
  console.log("\n── ESECUZIONE saveNuovoContratto (Privato) ──");
  await ctrl.saveNuovoContratto(reqSave, respSave.res);
  if (respSave.calls.renders.length > 0) {
    throw new Error("saveNuovoContratto Privato fallito: " + JSON.stringify(respSave.calls.renders));
  }

  const nuovo = await prisma.contratto.findFirst({
    where:   { giocatoreId, valido: true, fantaTeamId: { not: contrattoA.fantaTeamId } },
    orderBy: { createdAt: "desc" },
  });
  if (!nuovo) throw new Error("Nessun nuovo contratto B trovato.");
  console.log("Nuovo contratto B id=", nuovo.id, "prezzo=", nuovo.prezzoAcquisto?.toString(), "stipendio=", nuovo.importoOperazione?.toString());

  const stateAfterCreate = await snapshotState({ giocatoreId, buyerSfId: sfBuyer.id, sellerSfId: sfSeller.id });
  console.log("\n── POST-STIPULA ────────");
  console.log("contratti per giocatore:", stateAfterCreate.contratti.length);
  console.log("contratto A valido ora:", stateAfterCreate.contratti.find(c => c.id === contrattoA.id)?.valido);
  console.log("buyer  crediti=", stateAfterCreate.sfBuyer.crediti);
  console.log("seller crediti=", stateAfterCreate.sfSeller.crediti);

  // Annullamento
  const reqAnn = { user: { id: admin.id, role: "ADMIN" }, params: { id: String(nuovo.id) }, query: {}, body: {} };
  const respAnn = mockResp("ANNULLA2");
  console.log("\n── ESECUZIONE annullaContratto ──");
  await ctrl.annullaContratto(reqAnn, respAnn.res);

  const stateAfterAnnulla = await snapshotState({ giocatoreId, buyerSfId: sfBuyer.id, sellerSfId: sfSeller.id });
  console.log("\n── POST-ANNULLAMENTO ───");
  console.log("contratti per giocatore:", stateAfterAnnulla.contratti.length);
  console.log("contratto A valido ora:", stateAfterAnnulla.contratti.find(c => c.id === contrattoA.id)?.valido);
  console.log("buyer  crediti=", stateAfterAnnulla.sfBuyer.crediti, "stipendi=", stateAfterAnnulla.sfBuyer.stipendi);
  console.log("seller crediti=", stateAfterAnnulla.sfSeller.crediti, "stipendi=", stateAfterAnnulla.sfSeller.stipendi);

  console.log("\n── DIFF PRE vs POST-ANNULLAMENTO ──");
  const diffs = diffSnapshots(stateBefore, stateAfterAnnulla);
  if (diffs.length === 0) {
    console.log("✅ PRIVATO: stato identico dopo annullamento.");
  } else {
    console.log("❌ PRIVATO: differenze residue:");
    diffs.forEach(d => console.log("  •", d));
    process.exitCode = 1;
  }
}

async function main() {
  console.log("\n══════════ TEST CONTRATTO: STIPULA + ANNULLAMENTO ══════════\n");

  // 1. Admin user
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { id: "asc" } });
  if (!admin) throw new Error("Nessun admin in DB.");
  console.log("Admin:", admin.email, "id=", admin.id);

  // 2. Presidente acquirente (B) con situazione_finanziaria 2025-2026
  const sfBuyer = await prisma.situazioneFinanziaria.findFirst({
    where:   { stagione: "2025-2026" },
    orderBy: { id: "asc" },
  });
  if (!sfBuyer) throw new Error("Nessuna situazione_finanziaria 2025-2026.");
  const buyerUser = await prisma.user.findFirst({
    where: { OR: [{ nickname: sfBuyer.nomePresidente }, { email: sfBuyer.nomePresidente }], isActive: true },
  });
  if (!buyerUser) throw new Error(`User per presidente '${sfBuyer.nomePresidente}' non trovato.`);
  console.log("Acquirente B:", sfBuyer.nomePresidente, "userId=", buyerUser.id, "sfId=", sfBuyer.id);

  // 3. Giocatore LIBERO (no contratto valido) con valore TM
  const giocatore = await prisma.giocatore.findFirst({
    where: {
      active:        true,
      valore:        { not: null },
      contratti:     { none: { valido: true } },
    },
    orderBy: { nome: "asc" },
    select:  { id: true, nome: true, squadra: true, valore: true },
  });
  if (!giocatore) throw new Error("Nessun giocatore libero attivo con valore.");
  console.log("Giocatore libero:", giocatore.nome, "id=", giocatore.id, "valore=", giocatore.valore.toString());

  // 4. Snapshot pre-stipula
  const stateBefore = await snapshotState({
    giocatoreId: giocatore.id,
    buyerSfId:   sfBuyer.id,
    sellerSfId:  null,
  });
  console.log("\n── PRE-STIPULA ─────────────────────");
  console.log("contratti per giocatore:", stateBefore.contratti.length);
  console.log("buyer  crediti=", stateBefore.sfBuyer.crediti, "patrimonio=", stateBefore.sfBuyer.patrimonio, "stipendi=", stateBefore.sfBuyer.stipendi);

  // 5. Costruisci req per saveNuovoContratto
  const valoreTM    = parseFloat(giocatore.valore.toString());
  const prezzo      = Math.round(valoreTM * 1.0 * 10) / 10; // dentro range ±40%, 1 decimale
  const stipendio   = Math.round(valoreTM * 0.10 * 100) / 100;
  console.log("\nParametri test: valoreTM=", valoreTM, "prezzo=", prezzo, "stipendio atteso=", stipendio);

  const reqSave = {
    user:   { id: admin.id, role: "ADMIN" },
    params: {},
    query:  {},
    body: {
      tipo:               "Acquisto",
      clausola:           "",
      sessione:           "Estiva",
      dataStipula:        "07-2025",
      durataContratto:    "2",
      giocatoreId:        String(giocatore.id),
      fantaPresidenteId:  String(buyerUser.id),
      prezzoAcquisto:     String(prezzo),
      importoOperazione:  "",        // server lo ricalcola
      provenienza:        "Pubblico",
      destinazione:       "",
    },
  };
  const respSave = mockResp("SAVE");

  console.log("\n── ESECUZIONE saveNuovoContratto ─────");
  await ctrl.saveNuovoContratto(reqSave, respSave.res);
  if (respSave.calls.renders.length > 0) {
    throw new Error("saveNuovoContratto ha renderizzato (errore form): " + JSON.stringify(respSave.calls.renders));
  }

  // 6. Trova il contratto appena creato
  const nuovo = await prisma.contratto.findFirst({
    where:   { giocatoreId: giocatore.id, valido: true },
    orderBy: { createdAt: "desc" },
  });
  if (!nuovo) throw new Error("Nessun contratto valido trovato dopo saveNuovoContratto.");
  console.log("Nuovo contratto id=", nuovo.id, "prezzo=", nuovo.prezzoAcquisto?.toString(), "importo=", nuovo.importoOperazione?.toString());

  // 7. Snapshot post-stipula
  const stateAfterCreate = await snapshotState({
    giocatoreId: giocatore.id,
    buyerSfId:   sfBuyer.id,
    sellerSfId:  null,
  });
  console.log("\n── POST-STIPULA ────────────────────");
  console.log("contratti per giocatore:", stateAfterCreate.contratti.length);
  console.log("buyer  crediti=", stateAfterCreate.sfBuyer.crediti, "patrimonio=", stateAfterCreate.sfBuyer.patrimonio, "stipendi=", stateAfterCreate.sfBuyer.stipendi);

  // Sanity: il delta crediti del buyer = -(prezzo + stipendio)
  const deltaCrediti = parseFloat(stateAfterCreate.sfBuyer.crediti) - parseFloat(stateBefore.sfBuyer.crediti);
  const deltaAtteso  = -(prezzo + parseFloat(nuovo.importoOperazione));
  console.log("delta crediti buyer:", deltaCrediti.toFixed(2), "atteso:", deltaAtteso.toFixed(2));

  // 8. Annulla
  const reqAnn = {
    user:   { id: admin.id, role: "ADMIN" },
    params: { id: String(nuovo.id) },
    query:  {},
    body:   {},
  };
  const respAnn = mockResp("ANNULLA");

  console.log("\n── ESECUZIONE annullaContratto ───────");
  await ctrl.annullaContratto(reqAnn, respAnn.res);

  // 9. Snapshot post-annullamento
  const stateAfterAnnulla = await snapshotState({
    giocatoreId: giocatore.id,
    buyerSfId:   sfBuyer.id,
    sellerSfId:  null,
  });
  console.log("\n── POST-ANNULLAMENTO ──────────────");
  console.log("contratti per giocatore:", stateAfterAnnulla.contratti.length);
  console.log("buyer  crediti=", stateAfterAnnulla.sfBuyer.crediti, "patrimonio=", stateAfterAnnulla.sfBuyer.patrimonio, "stipendi=", stateAfterAnnulla.sfBuyer.stipendi);

  // 10. Diff
  console.log("\n══════════ DIFF PRE-STIPULA vs POST-ANNULLAMENTO ══════════\n");
  const diffs = diffSnapshots(stateBefore, stateAfterAnnulla);
  if (diffs.length === 0) {
    console.log("✅ STATO IDENTICO: annullamento ha ripristinato perfettamente lo stato pre-stipula.");
  } else {
    console.log("❌ DIFFERENZE RESIDUE:");
    diffs.forEach(d => console.log("  •", d));
    process.exitCode = 1;
  }

  // Log audit: stampa entries log_azioni create da questo test
  console.log("\n── LOG AZIONI GENERATI ─────────");
  const logs = await prisma.log.findMany({
    where: {
      adminId:   admin.id,
      createdAt: { gte: new Date(Date.now() - 60 * 1000) }, // ultimi 60s
    },
    orderBy: { id: "asc" },
  });
  logs.forEach(l => {
    let det = l.dettaglio;
    try { det = JSON.parse(l.dettaglio); } catch { /* ignore */ }
    console.log(`  log#${l.id} ${l.azione} ${l.entita} entitaId=${l.entitaId} createdAt=${l.createdAt.toISOString()}`);
    if (det && typeof det === "object") {
      console.log("    dettaglio:", JSON.stringify(det).slice(0, 240) + (JSON.stringify(det).length > 240 ? "…" : ""));
    }
  });

  // Test 2: Privato
  await testScenarioPrivato(admin);
}

main()
  .catch(err => {
    console.error("\n❌ Test fallito:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
