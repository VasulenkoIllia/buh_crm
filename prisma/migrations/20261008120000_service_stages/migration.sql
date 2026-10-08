-- A service's stages, and the stage a task stands on (owner, 2026-10-08; catalog.md, tasks.md).
--
-- Additive: a new table and a nullable column. Adding a nullable column with no default is
-- catalog-only, whatever the size of "Task". Building "Task_stageId_idx" and checking the new
-- foreign key each read "Task" once, blocking writes to it while they do; every task's stage is
-- null, so neither can fail, and at this firm's size it is a moment. No service has stages until
-- somebody adds them, so nothing changes on deploy.

-- CreateTable
CREATE TABLE "ServiceStage" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceStage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceStage_serviceId_order_idx" ON "ServiceStage"("serviceId", "order");

-- AddForeignKey
ALTER TABLE "ServiceStage" ADD CONSTRAINT "ServiceStage_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "stageId" UUID;

-- CreateIndex
CREATE INDEX "Task_stageId_idx" ON "Task"("stageId");

-- AddForeignKey: a stage a task stands on cannot be deleted from under it
ALTER TABLE "Task" ADD CONSTRAINT "Task_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ServiceStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
