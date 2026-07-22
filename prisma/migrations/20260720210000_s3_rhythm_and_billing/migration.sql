-- Intuitive rhythm config: month-of-period for quarterly/yearly task templates
-- (dayOfPeriod -1 now means "last day"); invoice timing gains "end of period".

ALTER TABLE "TaskTemplate" ADD COLUMN "monthOfPeriod" INTEGER;

ALTER TYPE "InvoiceTrigger" ADD VALUE 'on_period_end';
