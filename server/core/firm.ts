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
/** in flight, so a run of letters on a cold cache does not queue a read each */
let reloading = false;

/** How the name is fetched. A parameter so the failure path can be tested without a database. */
export type ReadFirmName = () => Promise<string | null>;

const readFromDb: ReadFirmName = async () => {
  const firm = await prisma.firmProfile.findUnique({
    where: { id: 1 },
    select: { name: true },
  });
  return firm?.name ?? null;
};

/** Remembered so the background retry below asks the same place the first attempt did. */
let source: ReadFirmName = readFromDb;

/**
 * Load the name into the cache. Tolerant — a letter must not be blocked by a cold cache — but
 * never SILENT: an empty catch here meant one transient read failure at boot left `cached` null for
 * the life of the process, and every invite and password reset then printed `APP_NAME` in its
 * masthead. Nothing surfaced it: Settings reads the name straight from the database, so the screen
 * showed the right one and only a client reading a letter would ever have seen the wrong one
 * (audit 2026-09-04).
 */
export async function loadFirmName(read?: ReadFirmName): Promise<void> {
  if (read) source = read;
  try {
    const name = await source();
    if (name?.trim()) cached = name.trim();
  } catch (err) {
    console.error(
      "[firm] could not read the firm name; letters will say APP_NAME until this succeeds. " +
        "On a first boot, before the first migration, there is no table yet and bootstrap fixes it.",
      err,
    );
  }
}

/** Keep it true when the firm renames itself, so the next letter says the new name. */
export function rememberFirmName(name: string): void {
  const trimmed = name.trim();
  if (trimmed) cached = trimmed;
}

/**
 * What a letter prints.
 *
 * Falls back to `APP_NAME` only while nothing has been loaded — the same value `bootstrap` seeds
 * the profile with, so the fallback is the profile's own default rather than a second idea of what
 * the firm is called. A cold cache also asks for the name again in the background, so the fallback
 * lasts one letter rather than until the next deploy. Stays synchronous: see the note above.
 */
export function firmName(): string {
  if (cached === null && !reloading) {
    reloading = true;
    void loadFirmName().finally(() => {
      reloading = false;
    });
  }
  return cached ?? config.APP_NAME;
}

/** What `doc.image` can read. A letterhead may also be WebP or GIF, which it cannot. */
const PRINTABLE_LOGO_TYPES = ["image/png", "image/jpeg"];

export const isPrintableLogo = (file: { mime: string }) =>
  PRINTABLE_LOGO_TYPES.includes(file.mime);

const filled = (text: string | null) => text?.trim() || null;

/**
 * Who an invoice is from, as it prints: the firm's name and postal address until somebody writes
 * something else in Settings → Invoices. An invoice with no sender at all is the one thing this
 * cannot do, so the name always resolves.
 *
 * The logo is the letterhead: the same mark, on the same white, for the same reader.
 *
 * Here because two modules read it, Settings to show it and Payments to print it.
 */
export async function readInvoiceIssuer() {
  const firm = await prisma.firmProfile.findUniqueOrThrow({
    where: { id: 1 },
    include: { mailLogoFile: true },
  });
  return {
    name: filled(firm.invoiceFromName) ?? firm.name,
    address: filled(firm.invoiceFromAddress) ?? filled(firm.postalAddress),
    website: filled(firm.invoiceFromWebsite),
    email: filled(firm.invoiceFromEmail),
    phone: filled(firm.invoiceFromPhone),
    paymentInfo: filled(firm.invoicePaymentInfo),
    logoFile: firm.mailLogoFile,
  };
}
export type InvoiceIssuer = Awaited<ReturnType<typeof readInvoiceIssuer>>;
