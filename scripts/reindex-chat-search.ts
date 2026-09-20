import { prisma, disconnectDb } from "../server/core/db.js";
import { openOptions, openText } from "../server/modules/chat/chat.sealing.js";
import { reindex } from "../server/modules/chat/chat.search.js";

/**
 * **Write the search index again, for every message that still exists** (chat.md §8).
 *
 * A message is indexed as it is sent, so this is not part of ordinary life. It exists for the two
 * occasions on which the index and the messages fall out of step, and on both of them the symptom
 * is the same and badly misleading: the search says "Nothing found" about a message the reader can
 * see on the screen.
 *
 * 1. **The index changed shape.** It held one hash per word-prefix until 2026-09-20 and holds one
 *    per three letters since, so that any part of a word can be searched. The migration emptied the
 *    table, because a prefix hash can never match a trigram query — and every message written
 *    before it stayed invisible to the search until this script was written (found by the owner,
 *    2026-09-20, on a chat full of test messages).
 * 2. **`SECRETS_KEY` was rotated.** The sealed text stays readable through its own `keyVersion`;
 *    the hashes cannot be re-opened, so the whole index silently matches nothing. chat.md §21 has
 *    said a rotation needs this step since the search shipped; this is that step.
 *
 * It is safe to run at any time and safe to run twice: each message's rows are cleared and written
 * again, one message at a time, so nothing is ever half-indexed. It reads and re-seals nothing —
 * the messages themselves are not touched.
 *
 *     npx tsx --env-file=.env scripts/reindex-chat-search.ts          # every chat
 *     npx tsx --env-file=.env scripts/reindex-chat-search.ts <chatId> # one chat
 *
 * On the server, inside the container:
 *     docker compose exec app npx tsx scripts/reindex-chat-search.ts
 */

const BITE = 200;

async function main() {
  const only = process.argv[2];
  if (only && !/^[0-9a-f-]{36}$/i.test(only)) {
    throw new Error("Give a chat id, or nothing at all for every chat");
  }

  const where = {
    deletedAt: null,
    kind: { not: "notice" as const },
    ...(only ? { chatId: only } : {}),
  };
  const total = await prisma.chatMessage.count({ where });
  console.log(
    `${total} message${total === 1 ? "" : "s"} to index${only ? ` in ${only}` : ""}.`,
  );

  let done = 0;
  let withWords = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.chatMessage.findMany({
      where,
      // by id, so a message sent while this runs cannot shift the page under it; it indexes
      // itself as it is sent anyway
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: BITE,
      select: {
        id: true,
        chatId: true,
        ciphertext: true,
        iv: true,
        authTag: true,
        keyVersion: true,
        poll: { select: { ciphertext: true, iv: true, authTag: true, keyVersion: true } },
      },
    });
    if (page.length === 0) break;
    cursor = page.at(-1)!.id;

    for (const message of page) {
      const texts = [openText(message), ...(message.poll ? openOptions(message.poll) : [])];
      await reindex(message.chatId, message.id, texts);
      if (texts.some((t) => t && t.trim())) withWords++;
      done++;
    }
    console.log(`  ${done}/${total}`);
  }

  const rows = await prisma.chatSearchToken.count(
    only ? { where: { chatId: only } } : undefined,
  );
  // a message of files alone, a poll whose question is two letters, a notice: all of them are
  // meant to have no tokens, so "fewer indexed than read" is not a fault
  console.log(
    `Done. ${done} messages read, ${withWords} had words worth indexing, ${rows} token rows now.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
