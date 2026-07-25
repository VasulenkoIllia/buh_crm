-- Internal task templates: recurring firm-internal tasks (no client, no billing).
-- Template gains a description + multiple default assignees (seeded onto generated tasks).
ALTER TABLE "TaskTemplate" ADD COLUMN "description" TEXT;
ALTER TABLE "TaskTemplate" ADD COLUMN "defaultAssigneeIds" JSONB;

-- Internal generated tasks have subscriptionId IS NULL, so the (subscriptionId, taskTemplateId,
-- periodKey) unique index can't dedup them (NULLs are distinct in Postgres). This partial unique
-- index keeps their generation idempotent by (template, period). Manual tasks (taskTemplateId NULL)
-- are excluded.
CREATE UNIQUE INDEX "Task_internal_template_period"
  ON "Task"("taskTemplateId", "periodKey")
  WHERE "subscriptionId" IS NULL AND "taskTemplateId" IS NOT NULL;
