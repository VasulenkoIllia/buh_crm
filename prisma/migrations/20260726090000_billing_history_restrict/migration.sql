-- Billing history must not break: the company / service / subscription an invoice (or a task,
-- or a subscription) points at can no longer be deleted out from under it. The app already
-- refuses these deletes (catalog usage guard, company-in-use guard) — this makes the database
-- refuse them too, so no raw statement or future code path can blank the reference.
ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_serviceId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_subscriptionId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_companyId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_serviceId_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_companyId_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "Subscription_companyId_fkey";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
