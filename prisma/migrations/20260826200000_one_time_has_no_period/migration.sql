-- A one-time service has no billing period, so it must not store one.
--
-- `period` was written as 'month' for every one-time subscription, with a code comment saying the
-- value was unused. It was not unused: the clients list read it and labelled a row "monthly" —
-- beside an Amount that had per-JOB prices summed into a per-PERIOD fee. A placeholder that means
-- nothing is one that some reader will eventually believe, so it stops existing.
ALTER TABLE "Subscription" ALTER COLUMN "period" DROP NOT NULL;

-- back-fill: clear the placeholder wherever the service bills per job
UPDATE "Subscription" s
   SET "period" = NULL
  FROM "Service" v
 WHERE v.id = s."serviceId"
   AND v.type = 'one_time';
