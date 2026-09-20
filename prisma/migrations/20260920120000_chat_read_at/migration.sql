-- S19 stage A.4 (chat.md §5.4): when a member's read marker last moved, which is what "Read by"
-- shows beside each name. Additive: one nullable column, no row changes.

-- AlterTable
ALTER TABLE "ChatMember" ADD COLUMN     "lastReadAt" TIMESTAMP(3);

