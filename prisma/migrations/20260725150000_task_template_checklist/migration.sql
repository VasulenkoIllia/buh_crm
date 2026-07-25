-- Default checklist steps for a service task template (string[] as JSONB).
-- Seeded onto generated (kind=sub) tasks and prefilled into the manual create form;
-- per-client override lives in Subscription.rhythmOverrides[templateId].checklist.
ALTER TABLE "TaskTemplate" ADD COLUMN "defaultChecklist" JSONB;
