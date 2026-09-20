import { createHmac } from "node:crypto";
import type { ChatSearchHit, ChatSearchPage, ChatSearchQuery } from "@shared/schema/chat.js";
import type { User } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { zonedDayStart } from "../../core/dates.js";
import { keyFor } from "../../core/secrets-crypto.js";
import * as repo from "./chat.repository.js";
import { openGroup, openOptions, openText } from "./chat.sealing.js";
import { requireMember } from "./chat.service.js";

/**
 * **Searching text nobody can read** (chat.md §8), by any PART of a word (owner, 2026-09-20).
 *
 * A message's words are sealed with everything else, so the search cannot look at them. What it
 * looks at instead is a keyed hash of every three letters of them, sliding along: "invoice" is
 * `inv`, `nvo`, `voi`, `oic`, `ice`. A query is cut the same way, and a message that holds ALL of
 * the query's triples is a candidate — then, and only then, the page being shown is decrypted and
 * the real text is checked for the query itself. So "оїн" finds "воїнська", the way people expect
 * of a chat, and the false candidates a triple-match can throw up never reach the screen.
 *
 * Whole words and their prefixes are a special case of this, which is why the prefix index it
 * replaces is gone: three letters anywhere is strictly more than three letters at the start.
 *
 * **What this gives away, said plainly** (§8): somebody with the database and without the key sees
 * hashes. They cannot turn one back into letters, but they can see that two messages share a triple,
 * and a triple they GUESS can be confirmed if they also hold the key — a little more than the
 * prefix index gave away, because three letters of a long word are now indexed wherever they stand.
 * That is the price of searching encrypted text by part of a word, and it is why the key is derived
 * rather than `SECRETS_KEY` itself.
 *
 * Only the page being shown is decrypted, for its snippet and for that last check.
 */

/** Three letters: the shortest a person may search for, and the size of every stored piece. */
const GRAM = 3;
const MIN = GRAM;
/** 96 bits of an HMAC-SHA256: a guess is hopeless, and the index stays small. */
const TOKEN_BYTES = 12;
/** A pasted paragraph is not a query; the library's own limit (`core/client-search.ts`). */
const MAX_WORDS = 8;
const PAGE = 30;
/**
 * How many the index may hand over for checking. A message is a short string and opening one is
 * microseconds, so this is cheap; it is a bound rather than a budget, and a search that hits it
 * says "there is more" and asks for another word.
 */
const CANDIDATES = 500;
/** How much of a message a hit shows. */
const SNIPPET = 180;

const hash = (word: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    createHmac("sha256", keyFor("chat.search"))
      .update(word, "utf8")
      .digest()
      .subarray(0, TOKEN_BYTES),
  );

/**
 * Words as the search understands them: lower case, accents folded, punctuation and everything
 * else dropped. The folding is what makes `Olena` and `ОЛЕНА` the same word as typed either way.
 */
export function wordsIn(text: string): string[] {
  return folded(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN);
}

/** The same folding, over a whole text: what the last check compares against. */
export function folded(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * **The check the index cannot do.** A message holding every triple of the query may still not
 * contain it — so the page that is about to be shown is opened and asked plainly: does each of the
 * query's words appear in it, anywhere inside a word? That is what makes "оїн" find "воїнська" and
 * nothing else.
 */
export function reallyHolds(text: string, words: readonly string[]): boolean {
  const hay = folded(text);
  return words.every((word) => hay.includes(word));
}

/** Every three letters of a word, sliding along: what is stored, and what a query is cut into. */
export function gramsOf(word: string): string[] {
  if (word.length < GRAM) return [];
  const out: string[] = [];
  for (let at = 0; at + GRAM <= word.length; at++) out.push(word.slice(at, at + GRAM));
  return out;
}

/** What a message is findable by (§8): every triple of every word in it, each hashed once. */
export function tokensOf(
  texts: readonly (string | null | undefined)[],
): Uint8Array<ArrayBuffer>[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const word of wordsIn(text ?? "")) for (const gram of gramsOf(word)) seen.add(gram);
  }
  return [...seen].map(hash);
}

/**
 * The query, cut the same way. Every triple of every word must be in the message — which is a
 * NARROWING filter, not the answer: `inv` + `nvo` can both be in a message that never says
 * "invoice", so what comes back is checked against the real text before anybody sees it.
 */
export function queryTokens(q: string): Uint8Array<ArrayBuffer>[] {
  const seen = new Set<string>();
  for (const word of wordsIn(q).slice(0, MAX_WORDS)) for (const g of gramsOf(word)) seen.add(g);
  return [...seen].map(hash);
}

// ── keeping the index true (§8) ────────────────────────────────────────────────

/**
 * **What a message is findable by**, written in the same transaction as the message itself: its
 * text, and a poll's options, which are sealed separately (§8). A notice has no words of its own —
 * it is a code and some ids — so it is not searchable, which is right: nobody looks for "Olena
 * added Petro".
 */
export function indexTx(
  tx: repo.Tx,
  chatId: string,
  messageId: string,
  texts: readonly (string | null | undefined)[],
) {
  const tokens = tokensOf(texts);
  if (tokens.length === 0) return Promise.resolve({ count: 0 });
  return repo.insertTokensTx(tx, chatId, messageId, tokens);
}

/** An edit replaces a message's words; a delete takes them away (§8). */
export async function reindex(
  chatId: string,
  messageId: string,
  texts: readonly (string | null | undefined)[],
) {
  await repo.clearTokens(messageId);
  const tokens = tokensOf(texts);
  if (tokens.length > 0) await repo.insertTokens(chatId, messageId, tokens);
}

export const forget = (messageId: string) => repo.clearTokens(messageId);

// ── the two boxes (§8) ─────────────────────────────────────────────────────────

/** The line a hit shows: the words around the first one that matched, on one line. */
function snippetOf(text: string, words: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET) return flat;
  const folded = flat
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  let at = -1;
  for (const word of words) {
    const found = folded.indexOf(word);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return `${flat.slice(0, SNIPPET)}…`;
  const from = Math.max(0, at - 60);
  const cut = flat.slice(from, from + SNIPPET);
  return `${from > 0 ? "…" : ""}${cut}${from + SNIPPET < flat.length ? "…" : ""}`;
}

/**
 * **A box above the chat list searches every chat the reader is in; a box inside a chat searches
 * that one** (§8) — the same query, with `chatId` set or not. Filters: who wrote it, when, and
 * whether it carried files.
 *
 * Membership is the rule, as everywhere in the chat: the SQL joins the reader's own active
 * memberships, so a chat they are not in cannot appear even by accident, and asking about one
 * names it as not found.
 */
export async function search(user: User, query: ChatSearchQuery): Promise<ChatSearchPage> {
  if (query.chatId) await requireMember(query.chatId, user.id);
  const tokens = queryTokens(query.q);
  if (tokens.length === 0) return { hits: [], people: [], more: false, narrowed: false };

  const page = query.page ?? 0;
  const words = [...new Set(wordsIn(query.q))].slice(0, MAX_WORDS);
  // the index NARROWS; the text decides. Candidates are taken in one bite and checked, because a
  // page of survivors cannot be counted in SQL without opening the messages (§8.1)
  const candidates = await repo.searchMessages(user.id, tokens, {
    chatId: query.chatId,
    senderId: query.senderId,
    // the FIRM's day, not UTC's: at Europe/Kyiv "from the 20th" used to hide everything sent
    // between midnight and three in the morning, and "to the 20th" quietly included the early
    // hours of the 21st (audit, 2026-09-20). Every other day filter in the CRM goes through this
    from: query.from ? zonedDayStart(query.from, config.TZ) : undefined,
    to: query.to ? zonedDayStart(nextDay(query.to), config.TZ) : undefined,
    hasFiles: query.hasFiles,
    skip: 0,
    take: CANDIDATES,
  });

  /** The day after this one, so "to the 20th" means the end of the 20th in the firm's own zone. */
  function nextDay(dayIso: string): string {
    const day = new Date(`${dayIso}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString().slice(0, 10);
  }

  /** A message's searchable words: what it says, and a poll's options beside its question. */
  const wordsOf = (row: (typeof candidates)[number]) => {
    const said = openText(row) ?? "";
    const options =
      row.pollCiphertext && row.pollIv && row.pollAuthTag
        ? openOptions({
            ciphertext: row.pollCiphertext,
            iv: row.pollIv,
            authTag: row.pollAuthTag,
            keyVersion: row.pollKeyVersion ?? 1,
          }).join(" · ")
        : "";
    return [said, options].filter(Boolean).join(" — ");
  };

  const survivors = candidates
    .map((row) => ({ row, text: wordsOf(row) }))
    .filter(({ text }) => reallyHolds(text, words));
  const rows = survivors.slice(page * PAGE, page * PAGE + PAGE);
  if (rows.length === 0) {
    return { hits: [], people: [], more: false, narrowed: candidates.length === CANDIDATES };
  }

  const full = await repo.messagesById(rows.map(({ row }) => row.id));
  const byId = new Map(full.map((m) => [m.id, m]));
  const chats = await repo.chatsByIds([...new Set(rows.map(({ row }) => row.chatId))]);

  const hits: ChatSearchHit[] = rows.map(({ row, text }) => ({
    messageId: row.id,
    chatId: row.chatId,
    chatLabel: labelOfChat(chats.get(row.chatId), user.id),
    seq: row.seq,
    authorId: row.authorId,
    at: row.createdAt.toISOString(),
    snippet: snippetOf(text, words),
    files: byId.get(row.id)?.files.length ?? 0,
  }));

  const ids = new Set(hits.flatMap((h) => (h.authorId ? [h.authorId] : [])));
  return {
    hits,
    people: ids.size > 0 ? await repo.peopleByIds([...ids]) : [],
    // one more page of survivors. A bite that filled up may be hiding more behind it, but saying
    // so gave a "more" that answers with nothing (audit, 2026-09-20): `narrowed` is the honest
    // way to say it, and the box shows it as a line rather than as another page
    more: survivors.length > (page + 1) * PAGE,
    narrowed: candidates.length === CANDIDATES,
  };
}

/** What a hit calls the chat it is in — to a member, who may of course see its name (§4.2). */
function labelOfChat(chat: repo.ChatForLabel | undefined, meId: string): string {
  if (!chat) return "A chat";
  switch (chat.kind) {
    case "group":
      return openGroup(chat)?.title ?? "A group";
    case "announcements":
      return "Firm announcements";
    case "saved":
      return "Saved messages";
    default: {
      const peer = chat.members.find((m) => m.userId !== meId)?.user;
      return peer ? `${peer.firstName} ${peer.lastName}`.trim() : "A chat";
    }
  }
}
