# MyFanta App

App web di gestione lega di fantacalcio italiana. Tracciamento contratti, situazione finanziaria dei fantapresidenti, rinnovi, svincoli, sincronizzazione quotazioni da Transfermarkt e rollover di fine stagione.

---

## Stack tecnico

| Strato | Tecnologia |
|---|---|
| Runtime | Node.js (CommonJS) |
| Framework HTTP | Express 5 |
| View engine | EJS |
| ORM | Prisma 7 + adapter `@prisma/adapter-pg` |
| DB | PostgreSQL |
| Auth | JWT in cookie + `bcryptjs` |
| Scraping | Playwright + stealth plugin |
| Logging HTTP | morgan |

Frontend lato server (EJS + CSS inline), SortableJS via CDN per drag-and-drop nella pagina rinnovi.

---

## Struttura directory

```
myfanta-app/
├── prisma/
│   ├── schema.prisma          # modelli DB
│   └── migrations/            # solo migration_lock.toml (migrazioni applicate via SQL manuale per drift)
├── scripts/                   # script one-off (sync render, fix dati, import sheet, backup, ecc.)
├── src/
│   ├── app.js                 # bootstrap Express, middleware, mount routes
│   ├── server.js              # entry point (avvia listener)
│   ├── lib/
│   │   ├── prisma.js          # client Prisma condiviso
│   │   └── sanitize.js        # helper input
│   ├── middleware/
│   │   ├── auth.middleware.js # requireAuth, requireAdmin, impersonificazione via ALS
│   │   └── error.js           # notFoundHandler, errorHandler
│   ├── routes/
│   │   ├── auth.js            # /auth/*
│   │   ├── admin.js           # /admin/* (gated da requireAdmin)
│   │   ├── fanta.js           # /fanta/*
│   │   ├── profile.js         # /profilo/*
│   │   └── health.js
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── admin.controller.js        # contratti, utenti, parametri, scraping, svincoli inattivi, impersonate
│   │   ├── fanta.controller.js        # classifica, riepilogo, rose, finanze, diario, log
│   │   ├── rinnovi.controller.js      # PropostaRinnovo: CRUD utente + finalize admin
│   │   ├── fine-stagione.controller.js# rollover 30 giugno (transazionale)
│   │   └── profile.controller.js
│   ├── services/
│   │   ├── auth.service.js
│   │   ├── log.service.js             # logAction + AsyncLocalStorage per impersonator
│   │   ├── parametri.service.js
│   │   ├── sheets.service.js          # legge Google Sheets pubblici (riepilogo)
│   │   ├── transfermarkt.service.js   # scraping con Playwright + cleanName
│   │   └── sync-quotazioni.service.js # match giocatori per nome normalizzato
│   └── views/                         # EJS templates (admin/, fanta/, auth/, partials/)
└── package.json
```

---

## Modello dati (Prisma)

| Modello | Tabella | Note |
|---|---|---|
| `User` | `fantapresidenti` | role: ADMIN / POWER_USER / USER. 1:1 opzionale con FantaTeam. |
| `FantaTeam` | `fanta_teams` | userId unique nullable (squadra senza utente assegnato è ammessa). |
| `SituazioneFinanziaria` | `situazione_finanziaria` | Per `(fantaTeamId, stagione)` UNIQUE e `(nomePresidente, stagione)` UNIQUE. Stagione attualmente in uso: `2025-2026`. |
| `Giocatore` | `giocatori` | Match per `nome` normalizzato (no più `transfermarktId`). Flag `active` per giocatori non più in Serie A. |
| `Quotazione` | `quotazioni` | Storico valori per giocatore (fonte default `transfermarkt`). |
| `Contratto` | `contratti` | tipo: Acquisto / Cessione / Prestito. clausola: DirittoRiscatto / ObbligoRiscatto / DirittoRicompra / ObbligoRicompra. `valido` flag per annullamento soft. |
| `RosaGiocatore` | `rosa_giocatori` | categoria: InRosa / FuoriRosa / U21. UNIQUE `(fantaTeamId, giocatoreId, stagione)`. |
| `PropostaRinnovo` | `proposte_rinnovo` | status: PENDING / APPROVED / REJECTED. UNIQUE `(fantaTeamId, stagione, ordinePriorita)`. 1:1 con Contratto. |
| `PremioErogato` | `premi_erogati` | tipo: InizioStagione / Gennaio. UNIQUE `(tipo, stagione)`. |
| `Log` | `log_azioni` | audit trail di tutte le azioni admin. `dettaglio` JSON: `{pre, post, impersonatedBy?}`. |
| `Parametro` | `parametri` | Coppie chiave/valore globali (`stagione_inizio`, `salary_cap_*`, slug squadre Serie A, ecc.). |

---

## Flussi principali

### Autenticazione e impersonificazione
- JWT in cookie httpOnly. `requireAuth` decodifica e popola `req.user`.
- Admin può impersonificare un altro utente tramite `POST /admin/users/:id/impersonate`. Il JWT acquisisce un claim `impersonator` con l'ID admin reale.
- `auth.middleware.js` esegue `next()` dentro un `AsyncLocalStorage` context con `{ impersonatorId }`, così `log.service.logAction()` auto-inietta `dettaglio.impersonatedBy` senza modificare i call site.
- `POST /admin/stop-impersonate` è registrata **prima** di `requireAdmin` (l'utente impersonato potrebbe non essere admin).

### Contratti
- **Acquisto / Cessione**: vincoli di sessione (Estiva/Invernale) sulla `dataStipula`. Movimenti su `SituazioneFinanziaria`: stipendi, valoreRose, crediti, patrimonio.
- **Prestito**: cap 5M cumulativo per stagione, no duplicati sullo stesso giocatore, buyer ≠ provenienza, giocatore deve avere un contratto Acquisto esistente. Movimenti SF solo su crediti/patrimonio/montePrestiti (no stipendi). Nessun vincolo di sessione. Annullabile con o senza restituzione dei crediti (flag `restituisciCrediti`).
- Annullamento contratto = soft delete (`valido = false`) + ripristino SF.

### Rinnovi (`PropostaRinnovo`)
- Utente: drag-and-drop priorità sui propri contratti in scadenza. Ingaggio calcolato server-side da `Quotazione.valore × 10%` (configurabile via parametro).
- Salary cap rinnovi globale: `(maxRosa + minRosa) / 2 × 25% × 10%` (computato live in `calcSalaryCapGlobale()`).
- Admin finalizza: step 0 ricalcola ingaggi su quotazione corrente, poi APPROVE/REJECT in ordine di priorità fino a esaurimento del cap.

### Fine stagione (rollover 30 giugno)
Transazione ACID singola (`prisma.$transaction`) in `fine-stagione.controller.js`:
1. `Contratto.durataContratto -= 1` su tutti i contratti validi.
2. Simulazione rinnovi PENDING per la nuova stagione (cap rinnovi, ingaggi ricalcolati).
3. Svincoli: contratti con `durataContratto ≤ 0` non rinnovati + proposte REJECTED. Refund su SF.
4. Creazione nuovi contratti Acquisto per i rinnovi APPROVED.
5. Log batch finale con pre/post per ciascuna variazione.

Rollback completo se uno step fallisce. Non annullabile da UI dopo successo (vive solo nei log).

### Sincronizzazione dati esterni
- **Transfermarkt scraping** (`transfermarkt.service.js`): per ogni squadra Serie A, Playwright headless naviga `https://www.transfermarkt.it/<slug>/startseite/verein/<id>`. `cleanName()` rimuove accenti/trattini/apostrofi + mapping speciale per `Ø/ı/ł/æ`. Match per nome normalizzato (no più `transfermarktId`).
- **Google Sheets** (`sheets.service.js`): legge un foglio pubblico riepilogo. Override in `fanta.controller.showRiepilogo` per `quotaRinnovi` con calcolo live tramite `calcQuotaRinnoviLive()`.

### Calendario Azioni Stagionali (`/admin/calendario-azioni`)
Dashboard unificata che mostra tutte le azioni scatenate in determinati momenti dell'anno, con:
- **Timeline visuale** della stagione (luglio → giugno) con evidenza mercato estivo/invernale e mese corrente.
- **Card per ogni azione**: mercato estivo, mercato invernale, mercato privato, stagione, premi inizio stagione, premi gennaio, finalizzazione rinnovi, svincoli inattivi, fine stagione, sync quotazioni.
- **Modifica date** direttamente (formato GG-MM) con salvataggio su parametri DB.
- **Stato real-time**: mostra se un mercato è aperto/chiuso, se i premi sono già erogati, quante proposte pending ci sono, ecc.
- **Trigger manuale**: pulsanti "Vai a…" (link alla pagina dedicata) e "Forza esecuzione" (POST diretto per i rinnovi).
- Controller: `admin.controller.js` → `showCalendarioAzioni`, `saveCalendarioDate`
- Vista: `views/admin/calendario-azioni.ejs`

---

## Comandi sviluppo

```bash
npm run dev               # nodemon su src/server.js
npm start                 # produzione
npm run prisma:generate   # rigenera client
npm run prisma:studio     # UI esplorazione DB
npm run db:backup         # backup locale
npm run db:backup-remote  # backup da Render
npm run render:sync       # push DB locale → Render
npm run render:pull       # pull DB Render → locale
```

**Migrazioni**: per drift consolidato non si usa `prisma migrate dev`. SQL applicato manualmente via `$executeRawUnsafe`, poi `prisma migrate resolve --applied <name>` per registrarla.

---

## Convenzioni codice

- CommonJS ovunque (`require` / `module.exports`). Ignorare suggerimenti IDE per ESM.
- Stringhe stagione formato `"YYYY-YYYY"` (es. `"2025-2026"`).
- Date contratto formato stringa `"DD-MM-YYYY"` o `"MM-YYYY"` (no oggetti `Date`).
- Decimal Prisma → sempre `.toNumber()` o `Number(x)` prima di matematica/JSON.
- Log azioni admin: usa `logAction(adminId, azione, entita, entitaId, { pre, post })`. L'impersonator viene aggiunto in automatico se attivo.
- Normalizzazione nome giocatore: `normName()` rimuove accenti (NFD + EXTRA_LATIN_MAP), tratta `-/'` come spazi, collassa spazi multipli, lowercase.

---

## Stato corrente (giugno 2026)

- Stagione attiva: **2025-2026**. Stagione di rinnovo target: 2026-2027.
- Concetto di selettore stagione **rimosso** dalla Situazione Patrimoniale: si mostra solo la stagione corrente derivata da `oggi.month vs parametro stagione_inizio`.
- Rosa/Stipendi/Prestiti/Giocatori/Età media → calcolati **live** dai contratti `valido=true`.
- Crediti/Patrimonio → letti da `SituazioneFinanziaria` stagione corrente.
- Quotazioni allineate post-scraping ultima sessione. Player merge eseguiti per duplicati storici (Milinkovic-Savic, Heggem, Venturino, +50 altri).
