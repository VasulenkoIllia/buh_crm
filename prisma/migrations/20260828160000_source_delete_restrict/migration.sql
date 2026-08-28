-- A source of origin may be deleted, but only while nothing records it.
--
-- Both foreign keys were ON DELETE SET NULL, which meant deleting a source would have silently
-- wiped it from every client and lead that held it — no warning, no trace, and no way afterwards
-- to learn what had been there. For the one field whose whole purpose is remembering where a
-- client came from, that is the wrong default.
--
-- The service counts usage before deleting and refuses with the numbers, but a count is taken a
-- moment before the delete: between the two, someone can pick that source on a new client. RESTRICT
-- is what makes the rule TRUE rather than probable — the count then exists only to turn a refusal
-- into a sentence a person can act on.
--
-- SET NULL served nothing here. An admin who wants a source out of the forms deactivates it; that
-- is what deactivation is for, and it keeps the history.
ALTER TABLE "Client" DROP CONSTRAINT "Client_sourceId_fkey";
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_sourceId_fkey";

ALTER TABLE "Client" ADD CONSTRAINT "Client_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "SourceOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "SourceOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
