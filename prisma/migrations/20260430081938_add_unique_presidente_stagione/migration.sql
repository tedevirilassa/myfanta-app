/*
  Warnings:

  - A unique constraint covering the columns `[nomePresidente,stagione]` on the table `situazione_finanziaria` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "situazione_finanziaria_nomePresidente_stagione_key" ON "situazione_finanziaria"("nomePresidente", "stagione");
