-- Per-client billing timing on subscriptions (null = inherit the service preset).
ALTER TABLE "Subscription" ADD COLUMN "invoiceTrigger" "InvoiceTrigger";
ALTER TABLE "Subscription" ADD COLUMN "invoiceDay" INTEGER;
