/**
 * The parts two client imports turned out to share.
 *
 * Extracted when the second one arrived (2026-08-27): the CSV reader and the phone normaliser were
 * about to be copied verbatim, and a second copy of "what counts as a phone number" is exactly the
 * kind of duplicate that drifts. What is NOT here is the column mapping — the two exports have
 * nothing in common there, and pretending otherwise would produce a worse function than either.
 */

/** RFC 4180, no dependency. Handles quoted fields, doubled quotes and newlines inside them. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // a BOM survives the export and would otherwise become part of the first header
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (src[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

/** Trim, collapse runs of whitespace, and fold the non-breaking spaces exports are full of. */
export const clean = (v: string | undefined): string =>
  (v ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

/**
 * US numbers to `+1XXXXXXXXXX`; anything of an unrecognised shape is kept verbatim rather than
 * mangled into a number that looks real and is not.
 */
export function normalisePhone(raw: string): string | null {
  const s = clean(raw).replace(/^'/, "");
  if (!s || /^https?:/i.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return s;
}

/** The last ten digits — what two phone numbers are compared on, country prefixes aside. */
export const phoneKey = (raw: string): string => raw.replace(/\D/g, "").slice(-10);

/**
 * A name, an email or a phone reduced to something comparable: case, accents and punctuation are
 * how the same person ends up looking like two.
 */
export const identityKey = (v: string): string =>
  clean(v)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@.+-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
