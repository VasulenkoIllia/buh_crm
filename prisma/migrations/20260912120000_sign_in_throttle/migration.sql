-- **Failed sign-ins, counted** (docs/modules/two-factor.md §9, Phase A).
--
-- A table of its own rather than the two places that already hold something similar: the activity
-- log can be switched off event by event from Settings → Activity, and a throttle that read it would
-- stop protecting anybody the day somebody silenced a noisy event; the rate limiter keeps its
-- counters in process memory and computes its key before the body is parsed, so it never sees
-- which account an attempt named.
--
-- `key` is a string with no foreign key on purpose — `acct:<typed address>`,
-- `pair:<typed address>|<network address>`, later `2fa:<user id>`. An address with no account is
-- counted exactly like one that has an account (the difference would tell an attacker which
-- addresses do), and the client portal can count its own sign-ins here without a second table.
--
-- Additive and empty on arrival; pruned nightly by `sessions:cleanup`.
CREATE TABLE "SignInThrottle" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "firstFailureAt" TIMESTAMP(3) NOT NULL,
    "lastFailureAt" TIMESTAMP(3) NOT NULL,
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "SignInThrottle_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "SignInThrottle_lastFailureAt_idx" ON "SignInThrottle"("lastFailureAt");
