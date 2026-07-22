-- Legacy rhythm backfill: before 20260720210000, quarterly/yearly templates stored
-- "day N of the WHOLE period" (quarterly 1-92, yearly 1-366). The new semantics is
-- monthOfPeriod (quarterly 1-3, yearly 1-12) + calendar day 1-31 (-1 = last day).
-- Reinterpret N as month ceil(N/31) + the day within that month so old rows stay
-- valid under rhythmValid and render sensibly. No-op on databases without such rows.

UPDATE "TaskTemplate"
SET "monthOfPeriod" = LEAST(("dayOfPeriod" + 30) / 31, 3),
    "dayOfPeriod"   = LEAST("dayOfPeriod" - (LEAST(("dayOfPeriod" + 30) / 31, 3) - 1) * 31, 31)
WHERE "periodicity" = 'quarterly' AND "dayOfPeriod" > 31;

UPDATE "TaskTemplate"
SET "monthOfPeriod" = LEAST(("dayOfPeriod" + 30) / 31, 12),
    "dayOfPeriod"   = LEAST("dayOfPeriod" - (LEAST(("dayOfPeriod" + 30) / 31, 12) - 1) * 31, 31)
WHERE "periodicity" = 'yearly' AND "dayOfPeriod" > 31;
