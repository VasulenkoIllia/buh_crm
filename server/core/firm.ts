import { config } from "./config.js";
import { prisma } from "./db.js";

/**
 * The firm's own name, as its letters print it.
 *
 * NOT `config.APP_NAME`. That is the container's technical identifier — it names the service in
 * `/health` and in compose — and putting it in a masthead means a client reads `buh_crm` where the
 * firm's name belongs (user, 2026-08-31). The name letters carry is the one the firm typed into
 * Settings, and it lives on `FirmProfile`.
 *
 * Held in memory rather than read per send, for one concrete reason: `sendEmail` records into the
 * test outbox before it awaits anything, and every caller's tests rely on that push having already
 * happened when the call returns. An `await` for this one string would defer it. The read is also
 * simply unnecessary on that path — the name changes when somebody renames the firm, not when a
 * letter goes out.
 */
let cached: string | null = null;

/** Load the name once at start-up. Tolerant: a letter must not be blocked by a cold cache. */
export async function loadFirmName(): Promise<void> {
  try {
    const firm = await prisma.firmProfile.findUnique({
      where: { id: 1 },
      select: { name: true },
    });
    if (firm?.name?.trim()) cached = firm.name.trim();
  } catch {
    // before the first migration there is no table to read; the fallback below covers it
  }
}

/** Keep it true when the firm renames itself, so the next letter says the new name. */
export function rememberFirmName(name: string): void {
  const trimmed = name.trim();
  if (trimmed) cached = trimmed;
}

/**
 * What a letter prints. Falls back to `APP_NAME` only when nothing has been loaded yet — which is
 * the same value `bootstrap` seeds the profile with, so the fallback is the profile's own default
 * rather than a second idea of what the firm is called.
 */
export function firmName(): string {
  return cached ?? config.APP_NAME;
}
