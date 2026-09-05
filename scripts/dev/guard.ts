/**
 * The one line every script in this folder runs first.
 *
 * These are DEVELOPMENT tools — they create fake tasks, fake users and fake mailboxes, and
 * `seed-notifications.ts` empties the whole `Notification` table so a run starts from a clean
 * tray. On a laptop that is exactly right. On the server it would clear every colleague's bell.
 *
 * And the server is reachable: `scripts/` is pulled with the rest of the repo, `tsx` is installed
 * in the image, and `npx tsx scripts/…` is an established gesture there — `deploy.sh` itself runs
 * `prune-uploads.ts` that way. One tab-completion away from the wrong filename.
 *
 * So the guard is a refusal, not a warning. `I_KNOW_THIS_IS_PRODUCTION=yes` exists because a
 * guard with no way past it gets deleted by whoever first needs past it.
 */
export function refuseOnProduction(what: string): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.I_KNOW_THIS_IS_PRODUCTION === "yes") {
    console.warn(`[dev-script] running ${what} against PRODUCTION on purpose — good luck.`);
    return;
  }
  console.error(
    `\nRefusing to run ${what}: NODE_ENV=production.\n\n` +
      `  These scripts create test data and delete real rows — seed-notifications.ts empties the\n` +
      `  entire Notification table, which is every colleague's bell, not just the test rows.\n\n` +
      `  If you genuinely mean it:  I_KNOW_THIS_IS_PRODUCTION=yes npx tsx ${what}\n`,
  );
  process.exit(1);
}
