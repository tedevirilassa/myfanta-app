-- CreateTable
CREATE TABLE "log_azioni" (
    "id"        SERIAL          NOT NULL,
    "azione"    TEXT            NOT NULL,
    "entita"    TEXT            NOT NULL,
    "entitaId"  INTEGER,
    "dettaglio" TEXT,
    "adminId"   INTEGER         NOT NULL,
    "createdAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "log_azioni_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "log_azioni" ADD CONSTRAINT "log_azioni_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "fantapresidenti"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
