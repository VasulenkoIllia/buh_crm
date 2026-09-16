/**
 * **How a person names a client when they are looking for something.**
 *
 * Two modules search across the firm — the library (files.md §13) and the vault (secrets.md §10) —
 * and a client is how people find things in both: "Olena Petrenko", "Petrenko", "C-142". The rule
 * lived in the library first and was copied into the vault the day the vault got its search; it
 * lives here now, so there is one rule and one test rather than two that drift
 * (owner, 2026-09-16: "так винеси, бо це окремий модуль").
 *
 * Two things it gets right, both learned from real use:
 *
 * - **every word on its own, in any order**, so a full name finds the client whichever way round it
 *   is typed. Comparing the whole query with each field found nothing for "Olena Petrenko", because
 *   no single field holds both words;
 * - **a code as people write it**: `142`, `#142`, `C-142`, `C–142` (an en dash, which is what a Mac
 *   makes of `C-142` while you type) or `C 142`. A number too long for the code's 32-bit column is
 *   not a code at all, which is what stops a pasted phone number throwing.
 */
import type { Prisma } from "../generated/prisma/client.js";

/** At most eight, so a pasted paragraph cannot turn into an eighty-clause query. */
export const MAX_QUERY_WORDS = 8;

export function wordsOf(q: string): string[] {
  return q.split(/\s+/).filter(Boolean).slice(0, MAX_QUERY_WORDS);
}

/** A case-insensitive `contains`, which is what every one of these comparisons wants. */
export function containing(text: string) {
  return { contains: text, mode: "insensitive" as const };
}

/** A client's code typed any of the usual ways; null when the text is not one. */
export function codeOf(text: string): number | null {
  // trimmed here rather than at each caller: both modules' queries arrive trimmed by their schema,
  // and a rule two modules share should not depend on that staying true
  const digits = text.trim().replace(/^#?\s*(?:c\s*[-–]?)?\s*/i, "");
  // digits alone, and within the 32-bit column: a pasted phone number is no code
  const code = /^\d+$/.test(digits) ? Number(digits) : 0;
  return code > 0 && code <= 2_147_483_647 ? code : null;
}

/** One word in a client: a part of its name or its company's, or its code. */
export function clientWord(word: string): Prisma.ClientWhereInput {
  const code = codeOf(word);
  return {
    OR: [
      { firstName: containing(word) },
      { lastName: containing(word) },
      { companyName: containing(word) },
      ...(code ? [{ code }] : []),
    ],
  };
}

/** A client with every word somewhere in its details, in any order, or the query as its code. */
export function clientText(q: string): Prisma.ClientWhereInput {
  const code = codeOf(q);
  return { OR: [{ AND: wordsOf(q).map(clientWord) }, ...(code ? [{ code }] : [])] };
}
