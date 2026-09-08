/**
 * Money is USD minor units (cents) everywhere in the app — never floats.
 *
 * Here rather than in `src/` because the SERVER needs it too and could not reach it: the overdue
 * invoice notification was composing its own amount with `.toFixed(2)` and reached a person as
 * "1250.00 outstanding" — no symbol, no thousands separator, on the one alert where an ambiguous
 * number is least acceptable (audit, 2026-09-08). `src/shared/lib/money.ts` re-exports this, so
 * there is one definition and not two that drift.
 *
 * No imports: the browser loads it.
 */

/** 123456 → "$1,234.56" */
export const fmtMoney = (minor: number) =>
  `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
