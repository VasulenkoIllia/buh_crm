-- Overdue terms: invoice counts as overdue N days after issue (service preset,
-- per-client override on the subscription; null = never / inherit).
ALTER TABLE "Service" ADD COLUMN "dueDays" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "dueDays" INTEGER;
