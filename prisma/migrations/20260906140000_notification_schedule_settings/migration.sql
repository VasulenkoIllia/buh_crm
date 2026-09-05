-- S9.2 — the two numbers a firm should own: when the nightly sweep runs, and how far ahead it
-- warns about a deadline.
--
-- Purely additive, and the defaults ARE the current behaviour: 07:00 and one day. A database that
-- takes this migration behaves identically until somebody changes the setting on the screen —
-- which is the only safe shape for a change to something that mails ten people every morning.
--
-- `notifySweepAt` is TEXT "HH:MM" rather than a time or two integers: it is written and read as one
-- field, never compared or sorted, and the cron expression is built from it. A `time` column would
-- carry a timezone question this value does not have — the hour is always in the FIRM's zone,
-- which is stored one column over.
ALTER TABLE "FirmProfile" ADD COLUMN     "notifyDeadlineDays" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "notifySweepAt" TEXT NOT NULL DEFAULT '07:00';
