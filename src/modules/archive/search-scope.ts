/** The three lists the Archive screen holds at once. */
export type ArchiveTab = "clients" | "leads" | "tasks";

/**
 * Which phrase a given list should be fetched with — the ANSWER is `undefined` for every tab the
 * user is not currently looking at.
 *
 * The Archive keeps all three lists mounted so that every chip carries a live count, and a chip's
 * number is read as "how much is in the archive here": it is how you decide which tab to open.
 * Feeding each list its own remembered phrase quietly broke that. A word left behind on Leads made
 * its chip read `Leads 0` while you stood on Tasks — which states that the archive holds no leads
 * when it holds one, and nothing on screen explains why (found in the browser, 2026-08-31).
 *
 * The phrases are still kept per tab; they come back with the tab, which is the whole point of
 * holding three of them. Only their EFFECT is scoped to what is visible.
 */
export function phraseFor(
  tab: ArchiveTab,
  key: ArchiveTab,
  phrases: Record<ArchiveTab, string>,
): string | undefined {
  return tab === key ? phrases[key] || undefined : undefined;
}
