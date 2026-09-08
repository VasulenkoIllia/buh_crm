/** Money is USD minor units (cents) everywhere in the app — never floats. */

// `fmtMoney` lives in `shared/` because the server composes amounts too (notification subjects).
// Re-exported rather than redefined: two formatters for one currency is how "$1,250.00" here and
// "1250.00" there happen.
export { fmtMoney } from "@shared/money";

/** "1 234,56" / "1234.56" → 123456 minor units. NaN-safe: bad input → 0. */
export function parseMoney(text: string): number {
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/** 123456 → "1234.56" — the editable form of an amount input. */
export const moneyInputValue = (minor: number) => (minor / 100).toFixed(2);
