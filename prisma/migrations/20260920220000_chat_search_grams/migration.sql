-- S19 stage C (chat.md §8): searching by any PART of a word, not only by its start.
--
-- The owner's call, 2026-09-20: "треба нормальний пошук … по частинах слів … як в телеграмі".
-- What is stored changes shape — every three letters of a word, sliding along, instead of its
-- prefixes — so every token written by the old scheme is meaningless to the new one. A prefix hash
-- can never equal a triple's hash of different letters, so a stale row would simply never match;
-- it is deleted anyway, because a table half full of rows nothing can ever read is a lie about what
-- the index holds.
--
-- No table changes: the shape (token, chatId, messageId) is the same. Production has no chat
-- messages at all (stage A has not been deployed), so this empties nothing there; on a machine
-- running the branch, what was written before is findable again as soon as it is edited, and the
-- deploy's summary says so.

DELETE FROM "ChatSearchToken";
