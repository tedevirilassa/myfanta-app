/*
  Warnings:

  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_invitedById_fkey";

-- DropTable
DROP TABLE "User";

-- CreateTable
CREATE TABLE "fantapresidenti" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "invitedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fantapresidenti_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fantapresidenti_email_key" ON "fantapresidenti"("email");

-- AddForeignKey
ALTER TABLE "fantapresidenti" ADD CONSTRAINT "fantapresidenti_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "fantapresidenti"("id") ON DELETE SET NULL ON UPDATE CASCADE;
