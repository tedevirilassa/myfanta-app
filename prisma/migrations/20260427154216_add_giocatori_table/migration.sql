-- CreateTable
CREATE TABLE "giocatori" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "ruoloEsteso" TEXT,
    "ruolo" CHAR(1) NOT NULL,
    "squadra" TEXT,
    "eta" INTEGER,
    "valore" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "giocatori_pkey" PRIMARY KEY ("id")
);
