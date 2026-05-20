-- Tabella proposte_rinnovo + enum StatoRinnovo.
-- Gestisce intenzioni di rinnovo dei contratti in scadenza con priorizzazione
-- drag-drop e finalizzazione transazionale guidata da salary cap.

CREATE TYPE "StatoRinnovo" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "proposte_rinnovo" (
  "id"              SERIAL PRIMARY KEY,
  "contrattoId"     INTEGER NOT NULL UNIQUE,
  "fantaTeamId"     INTEGER NOT NULL,
  "giocatoreId"     INTEGER NOT NULL,
  "stagione"        TEXT NOT NULL,
  "nuovaDurata"     INTEGER NOT NULL,
  "nuovoIngaggio"   DECIMAL(10,2) NOT NULL,
  "ordinePriorita"  INTEGER NOT NULL,
  "status"          "StatoRinnovo" NOT NULL DEFAULT 'PENDING',
  "motivoStato"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "proposte_rinnovo"
  ADD CONSTRAINT "proposte_rinnovo_contrattoId_fkey"
  FOREIGN KEY ("contrattoId") REFERENCES "contratti"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "proposte_rinnovo"
  ADD CONSTRAINT "proposte_rinnovo_fantaTeamId_fkey"
  FOREIGN KEY ("fantaTeamId") REFERENCES "fanta_teams"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "proposte_rinnovo"
  ADD CONSTRAINT "proposte_rinnovo_giocatoreId_fkey"
  FOREIGN KEY ("giocatoreId") REFERENCES "giocatori"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- Vincolo unicità ordine per team+stagione (richiesto da spec: no priorità duplicate)
CREATE UNIQUE INDEX "proposte_rinnovo_team_stagione_priorita_key"
  ON "proposte_rinnovo" ("fantaTeamId", "stagione", "ordinePriorita");

-- Index dedicato per simulazione live (richiesto da spec: velocizzare calcolo budget)
CREATE INDEX "proposte_rinnovo_team_priorita_idx"
  ON "proposte_rinnovo" ("fantaTeamId", "ordinePriorita");
