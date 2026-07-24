-- Normalize legacy/mixed-case user emails to lowercase (2026-07-24).
-- Login, invite and password-reset lowercase their input at the schema boundary,
-- but a row stored with a capital letter (created before that rule, or inserted
-- by hand) becomes unreachable — you can neither log in nor reset it. Fix the
-- data so the "stored emails are lowercase" invariant holds.
-- Skip a row if a lowercase twin already exists (that would violate the unique
-- index and needs a manual merge instead).
UPDATE "User" u
SET email = lower(email)
WHERE email <> lower(email)
  AND NOT EXISTS (
    SELECT 1 FROM "User" x WHERE x.email = lower(u.email) AND x.id <> u.id
  );
