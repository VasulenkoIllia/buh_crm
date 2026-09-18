import * as repo from "./chat.repository.js";

/**
 * **The firm's announcements channel, and everybody in it** (chat.md §3.3, §4.1).
 *
 * One channel, created on boot when it is missing: the first boot after stage A, and the first boot
 * after a `--reset`, which wipes every chat. Its `uniqueKey` makes a second one impossible, so two
 * processes booting at once still make one.
 *
 * Then its membership is made to match the team: every active person is in it, and nobody else.
 * Nobody may leave it, so a membership that was ended by a block comes back when the person is
 * unblocked, here or in the service (§11). Run on every boot; a later change of status is the users
 * module's to carry (step A.2), and this is what catches anything that slipped past.
 */
export const ANNOUNCEMENTS_KEY = "announcements";

export async function ensureAnnouncementsChannel(now = new Date()): Promise<string> {
  const channelId = await repo.upsertChannel(ANNOUNCEMENTS_KEY);
  await repo.matchChannelMembers(channelId, await repo.activeUserIds(), now);
  return channelId;
}
