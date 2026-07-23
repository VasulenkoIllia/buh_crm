-- One-time services hold JOB PRESETS, not rhythmic tasks (decision 2026-07-23):
-- a one-time service is a container manual jobs flow through; its task templates keep
-- only the deadline preset (offset from job creation) + planned time. Normalize any
-- existing templates on one-time services to periodicity 'once' with no day/month.

UPDATE "TaskTemplate" t
SET "periodicity" = 'once', "dayOfPeriod" = NULL, "monthOfPeriod" = NULL
FROM "Service" s
WHERE t."serviceId" = s."id" AND s."type" = 'one_time' AND t."periodicity" <> 'once';
