import { createHmac } from "node:crypto";
import type { ChatSearchHit, ChatSearchPage, ChatSearchQuery } from "@shared/schema/chat.js";
import type { User } from "../../generated/prisma/client.js";
import { keyFor } from "../../core/secrets-crypto.js";
import * as repo from "./chat.repository.js";
import { openGroup, openOptions, openText } from "./chat.sealing.js";
import { requireMember } from "./chat.service.js";

/**
 * **Searching text nobody can read** (chat.md §8).
 *
 * A message's words are sealed with everything else, so the search cannot look at them. What it
 * looks at instead is a keyed hash of each word and of every prefix of it from three letters:
 * "invoice" is stored as `inv`, `invo`, `invoi`, `invoic`, `invoice`, each hashed with a key
 * derived from `SECRETS_KEY` (`keyFor("chat.search")`). A search hashes the query's words the same
 * way and asks for the messages holding ALL of them, in any order — the rule the library and the
 * vault already answer names by.
 *
 * **What this gives away, said plainly** (§8): somebody with the database and without the key sees
 * hashes. They cannot turn one back into a word, but they can see that two messages share one, and
 * a word they GUESS can be confirmed if they also hold the key. That is the price of searching
 * encrypted text without decrypting all of it, and it is why the key is derived rather than
 * `SECRETS_KEY` itself.
 *
 * Only the page being shown is decrypted, for its snippet.
 */

/** Three letters is where a prefix starts being worth a row (§8), twelve is where it stops. */
const MIN = 3;
const MAX = 12;
/** 96 bits of an HMAC-SHA256: a guess is hopeless, and the index stays small. */
const TOKEN_BYTES = 12;
/** A pasted paragraph is not a query; the library's own limit (`core/client-search.ts`). */
const MAX_WORDS = 8;
const PAGE = 30;
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
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN);
}

/** Every word of a message, and every prefix of it worth a row: what is stored (§8). */
export function tokensOf(
  texts: readonly (string | null | undefined)[],
): Uint8Array<ArrayBuffer>[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const word of wordsIn(text ?? "")) {
      for (let n = MIN; n <= Math.min(word.length, MAX); n++) seen.add(word.slice(0, n));
    }
  }
  return [...seen].map(hash);
}

/**
 * The query's words, hashed. A word longer than the longest prefix stored is cut to it, so
 * searching for a long word finds the messages whose words START with those twelve letters — a
 * little wider than asked for, never narrower.
 */
export function queryTokens(q: string): Uint8Array<ArrayBuffer>[] {
  const words = [...new Set(wordsIn(q).map((word) => word.slice(0, MAX)))].slice(0, MAX_WORDS);
  return words.map(hash);
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
  if (tokens.length === 0) return { hits: [], people: [], more: false };

  const page = query.page ?? 0;
  const found = await repo.searchMessages(user.id, tokens, {
    chatId: query.chatId,
    senderId: query.senderId,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
    hasFiles: query.hasFiles,
    skip: page * PAGE,
    take: PAGE + 1,
  });
  const rows = found.slice(0, PAGE);
  if (rows.length === 0) return { hits: [], people: [], more: false };

  // only the page being shown is opened, which is the whole point of the token table
  const full = await repo.messagesById(rows.map((r) => r.id));
  const byId = new Map(full.map((m) => [m.id, m]));
  const chats = await repo.chatsByIds([...new Set(rows.map((r) => r.chatId))]);
  const words = [...new Set(wordsIn(query.q).map((w) => w.slice(0, MAX)))];

  const hits: ChatSearchHit[] = rows.map((row) => {
    const message = byId.get(row.id);
    const poll = message?.poll ? openOptions(message.poll).join(" · ") : "";
    const text = [openText(message ?? row) ?? "", poll].filter(Boolean).join(" — ");
    return {
      messageId: row.id,
      chatId: row.chatId,
      chatLabel: labelOfChat(chats.get(row.chatId), user.id),
      seq: row.seq,
      authorId: row.authorId,
      at: row.createdAt.toISOString(),
      snippet: snippetOf(text, words),
      files: message?.files.length ?? 0,
    };
  });

  const ids = new Set(hits.flatMap((h) => (h.authorId ? [h.authorId] : [])));
  return {
    hits,
    people: ids.size > 0 ? await repo.peopleByIds([...ids]) : [],
    more: found.length > PAGE,
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
