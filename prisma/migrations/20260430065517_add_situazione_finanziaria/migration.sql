-- CreateTable
CREATE TABLE "situazione_finanziaria" (
    "id" SERIAL NOT NULL,
    "nomePresidente" TEXT NOT NULL,
    "stagione" TEXT NOT NULL,
    "valoreRose" DECIMAL(10,2) NOT NULL,
    "crediti" DECIMAL(10,2) NOT NULL,
    "patrimonio" DECIMAL(10,2) NOT NULL,
    "giocatoriTesserati" INTEGER NOT NULL,
    "etaMedia" DECIMAL(5,2) NOT NULL,
    "stipendi" DECIMAL(10,2) NOT NULL,
    "montePrestiti" DECIMAL(10,2) NOT NULL,
    "ultimoPlusMinus" DECIMAL(10,2) NOT NULL,
    "fantaTeamId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "situazione_finanziaria_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "situazione_finanziaria" ADD CONSTRAINT "situazione_finanziaria_fantaTeamId_fkey" FOREIGN KEY ("fantaTeamId") REFERENCES "fanta_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
