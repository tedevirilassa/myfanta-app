-- Aggiunge vincolo UNIQUE (fantaTeamId, stagione) su situazione_finanziaria.
-- Previene duplicati di SF per lo stesso team nella stessa stagione.
-- NULLs trattati come distinct (Postgres default), quindi più SF senza
-- fantaTeamId valorizzato restano consentite (pending assignment).
ALTER TABLE "situazione_finanziaria"
  ADD CONSTRAINT "situazione_finanziaria_fantaTeamId_stagione_key"
  UNIQUE ("fantaTeamId", "stagione");
