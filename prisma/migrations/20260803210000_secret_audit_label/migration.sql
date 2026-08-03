-- The access log kept the secret's NAME only through a foreign key, so deleting a secret set it to
-- null and every past row became "—" — the log outlived the secret but forgot what it was about,
-- which is most of why it is kept (user, 2026-08-03).
--
-- Snapshot the label onto the row instead, the same way PaymentAuditLog snapshots before/after.
ALTER TABLE "SecretAuditLog" ADD COLUMN "label" TEXT;

-- backfill what is still reachable; rows whose secret is already gone stay null and read "(deleted)"
UPDATE "SecretAuditLog" a
SET "label" = s."label"
FROM "ClientSecret" s
WHERE a."secretId" = s."id";
