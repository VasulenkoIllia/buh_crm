-- S19 stage C (chat.md §4.3): a group has no roles.
--
-- The owner's call, 2026-09-20: "по чату овнер і мембері адмін — спрощуємо". A group of four
-- people in one firm does not need a hierarchy — everybody in one may rename it, add a colleague,
-- take one out, pin and leave. The one chat with a rule about who may WRITE is the announcements
-- channel, and that rule reads the FIRM's admin role, which lives on `User` and is untouched here.
-- Deleting somebody else's message is still a firm admin's, because it destroys something.
--
-- Destructive, and deliberately so: the column and its enum are dropped rather than left to rot.
-- Nothing is lost that anybody can see — production has no chat tables at all (stage A has not been
-- deployed), and on a machine running the branch the column only ever said "owner" for whoever
-- happened to create a group.
--
-- The two notices `role_changed` and `owner_changed` STAY in `ChatNotice`: PostgreSQL cannot drop a
-- value from an enum, and lines written before this still read.

-- AlterTable
ALTER TABLE "ChatMember" DROP COLUMN "role";

-- DropEnum
DROP TYPE "ChatMemberRole";
