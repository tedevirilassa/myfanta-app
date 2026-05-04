-- AlterTable: aggiungi nuovi campi a giocatori
ALTER TABLE "giocatori"
  ADD COLUMN IF NOT EXISTS "dataNascita"     TEXT,
  ADD COLUMN IF NOT EXISTS "nazionalita"     TEXT,
  ADD COLUMN IF NOT EXISTS "transfermarktId" TEXT;

-- CreateIndex: transfermarktId univoco
CREATE UNIQUE INDEX IF NOT EXISTS "giocatori_transfermarktId_key"
  ON "giocatori"("transfermarktId");

-- CreateTable: storico quotazioni
CREATE TABLE "quotazioni" (
    "id"          SERIAL NOT NULL,
    "giocatoreId" INTEGER NOT NULL,
    "valore"      DECIMAL(10,2),
    "fonte"       TEXT DEFAULT 'transfermarkt',
    "stagione"    TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotazioni_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "quotazioni"
  ADD CONSTRAINT "quotazioni_giocatoreId_fkey"
  FOREIGN KEY ("giocatoreId") REFERENCES "giocatori"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
