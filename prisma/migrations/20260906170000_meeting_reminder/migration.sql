-- S9.3 — an optional reminder a few minutes before a meeting starts.
--
-- One nullable column, no backfill, no default: NULL means "no reminder", which is exactly how
-- every meeting booked before today behaved. Nothing that already exists changes.
ALTER TABLE "Meeting" ADD COLUMN "remindMinutesBefore" INTEGER;
