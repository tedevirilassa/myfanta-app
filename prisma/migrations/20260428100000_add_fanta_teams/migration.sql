-- ============================================================
-- Aggiunge la tabella fanta_teams e migra i contratti
-- ============================================================

-- 1. Rimuovi teamName da fantapresidenti
ALTER TABLE "fantapresidenti" DROP COLUMN IF EXISTS "teamName";

-- 2. Crea la tabella fanta_teams
CREATE TABLE "fanta_teams" (
    "id"        SERIAL          NOT NULL,
    "nome"      TEXT            NOT NULL,
    "userId"    INTEGER         NOT NULL,
    "createdAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fanta_teams_pkey" PRIMARY KEY ("id")
);

-- 3. Indice univoco: un utente → un solo team
CREATE UNIQUE INDEX "fanta_teams_userId_key" ON "fanta_teams"("userId");

-- 4. Crea una riga in fanta_teams per ogni utente esistente
--    (usa il nickname come nome rosa; se assente, usa la parte locale dell'email)
INSERT INTO "fanta_teams" ("nome", "userId", "createdAt", "updatedAt")
SELECT
    COALESCE(nickname, split_part(email, '@', 1)) AS nome,
    id,
    NOW(),
    NOW()
FROM "fantapresidenti";

-- 5. Aggiungi fantaTeamId a contratti (nullable inizialmente)
ALTER TABLE "contratti" ADD COLUMN "fantaTeamId" INTEGER;

-- 6. Popola fantaTeamId dai contratti esistenti tramite fantaPresidenteId
UPDATE "contratti" c
SET "fantaTeamId" = ft.id
FROM "fanta_teams" ft
WHERE ft."userId" = c."fantaPresidenteId";

-- 7. Rimuovi fantaPresidenteId (FK e colonna)
ALTER TABLE "contratti" DROP CONSTRAINT IF EXISTS "contratti_fantaPresidenteId_fkey";
ALTER TABLE "contratti" DROP COLUMN "fantaPresidenteId";

-- 8. Rendi fantaTeamId NOT NULL
ALTER TABLE "contratti" ALTER COLUMN "fantaTeamId" SET NOT NULL;

-- 9. FK fanta_teams → fantapresidenti
ALTER TABLE "fanta_teams" ADD CONSTRAINT "fanta_teams_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "fantapresidenti"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10. FK contratti → fanta_teams
ALTER TABLE "contratti" ADD CONSTRAINT "contratti_fantaTeamId_fkey"
    FOREIGN KEY ("fantaTeamId") REFERENCES "fanta_teams"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
