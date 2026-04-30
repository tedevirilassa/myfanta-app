-- CreateEnum
CREATE TYPE "CategoriaRosa" AS ENUM ('InRosa', 'FuoriRosa', 'U21');

-- CreateTable
CREATE TABLE "rosa_giocatori" (
    "id" SERIAL NOT NULL,
    "fantaTeamId" INTEGER NOT NULL,
    "giocatoreId" INTEGER NOT NULL,
    "stagione" TEXT NOT NULL,
    "categoria" "CategoriaRosa" NOT NULL DEFAULT 'InRosa',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rosa_giocatori_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rosa_giocatori_fantaTeamId_giocatoreId_stagione_key" ON "rosa_giocatori"("fantaTeamId", "giocatoreId", "stagione");

-- AddForeignKey
ALTER TABLE "rosa_giocatori" ADD CONSTRAINT "rosa_giocatori_fantaTeamId_fkey" FOREIGN KEY ("fantaTeamId") REFERENCES "fanta_teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rosa_giocatori" ADD CONSTRAINT "rosa_giocatori_giocatoreId_fkey" FOREIGN KEY ("giocatoreId") REFERENCES "giocatori"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
