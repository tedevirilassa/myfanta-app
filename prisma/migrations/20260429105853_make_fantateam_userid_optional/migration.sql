-- DropForeignKey
ALTER TABLE "fanta_teams" DROP CONSTRAINT "fanta_teams_userId_fkey";

-- AlterTable
ALTER TABLE "fanta_teams" ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "fanta_teams" ADD CONSTRAINT "fanta_teams_userId_fkey" FOREIGN KEY ("userId") REFERENCES "fantapresidenti"("id") ON DELETE SET NULL ON UPDATE CASCADE;
