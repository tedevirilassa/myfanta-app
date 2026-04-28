-- CreateEnum
CREATE TYPE "TipoContratto" AS ENUM ('Acquisto', 'Cessione', 'Prestito');

-- CreateEnum
CREATE TYPE "ClausolaContratto" AS ENUM ('DirittoRiscatto', 'DirittoRicompra', 'ObbligoRiscatto', 'ObbligoRicompra');

-- CreateEnum
CREATE TYPE "ProvenienzaContratto" AS ENUM ('Pubblico', 'Privato');

-- CreateTable
CREATE TABLE "contratti" (
    "id" SERIAL NOT NULL,
    "tipo" "TipoContratto" NOT NULL,
    "clausola" "ClausolaContratto",
    "dataStipula" TEXT NOT NULL,
    "durataContratto" INTEGER NOT NULL,
    "dataFine" TEXT,
    "giocatoreId" INTEGER NOT NULL,
    "fantaPresidenteId" INTEGER NOT NULL,
    "valoreGiocatore" DECIMAL(10,2),
    "importoOperazione" DECIMAL(10,2),
    "provenienza" "ProvenienzaContratto",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contratti_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "contratti" ADD CONSTRAINT "contratti_giocatoreId_fkey"
    FOREIGN KEY ("giocatoreId") REFERENCES "giocatori"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contratti" ADD CONSTRAINT "contratti_fantaPresidenteId_fkey"
    FOREIGN KEY ("fantaPresidenteId") REFERENCES "fantapresidenti"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
