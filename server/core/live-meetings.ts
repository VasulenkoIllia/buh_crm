/**
 * "Its client and its lead are both still live": the rule that decides which meetings exist for
 * the firm, in the shape a meeting query needs.
 *
 * Without it an archived client's TASKS left the calendar while their MEETINGS stayed, which is
 * the worst of both: half the relationship vanished and half did not. The tasks module keeps the
 * same rule for tasks (`liveTargetWhere` in `tasks.repository.ts`).
 *
 * In core because two modules read meetings and neither may import the other: Meetings draws the
 * calendar, Notifications sends the morning letter and the reminder. While the rule lived in
 * Meetings alone, a colleague was mailed "Today at …", with the client's phone, about a meeting
 * the calendar no longer showed (owner, 2026-11-24).
 */
import type { Prisma } from "../generated/prisma/client.js";

export function liveMeetingWhere(): Prisma.MeetingWhereInput {
  return {
    AND: [
      { OR: [{ clientId: null }, { client: { archivedAt: null } }] },
      { OR: [{ leadId: null }, { lead: { archivedAt: null } }] },
    ],
  };
}
