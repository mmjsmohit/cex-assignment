/*
  Warnings:

  - You are about to drop the column `assetsId` on the `Fills` table. All the data in the column will be lost.
  - You are about to drop the column `assetsId` on the `OrderHistory` table. All the data in the column will be lost.
  - Added the required column `marketId` to the `OrderHistory` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Fills" DROP CONSTRAINT "Fills_assetsId_fkey";

-- DropForeignKey
ALTER TABLE "OrderHistory" DROP CONSTRAINT "OrderHistory_assetsId_fkey";

-- AlterTable
ALTER TABLE "Fills" DROP COLUMN "assetsId";

-- AlterTable
ALTER TABLE "OrderHistory" DROP COLUMN "assetsId",
ADD COLUMN     "marketId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "OrderHistory" ADD CONSTRAINT "OrderHistory_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
