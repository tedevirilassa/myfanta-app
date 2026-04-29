/*
  Warnings:

  - The `provenienza` column on the `contratti` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "contratti" DROP COLUMN "provenienza",
ADD COLUMN     "provenienza" TEXT;

-- DropEnum
DROP TYPE "ProvenienzaContratto";
