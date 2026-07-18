-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('individual', 'company');

-- DropForeignKey
ALTER TABLE "ClientCompany" DROP CONSTRAINT "ClientCompany_clientId_fkey";

-- DropForeignKey
ALTER TABLE "ClientCompany" DROP CONSTRAINT "ClientCompany_companyId_fkey";

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "type" "ClientType" NOT NULL DEFAULT 'individual',
ALTER COLUMN "firstName" DROP NOT NULL,
ALTER COLUMN "lastName" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "clientId" UUID NOT NULL,
ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "companyId" UUID;

-- DropTable
DROP TABLE "ClientCompany";

-- CreateTable
CREATE TABLE "ClientPerson" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "serviceLabel" TEXT,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPerson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientPerson_clientId_idx" ON "ClientPerson"("clientId");

-- CreateIndex
CREATE INDEX "Client_type_idx" ON "Client"("type");

-- CreateIndex
CREATE INDEX "Company_clientId_idx" ON "Company"("clientId");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPerson" ADD CONSTRAINT "ClientPerson_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

