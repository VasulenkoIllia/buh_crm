import { z } from "zod";
import { uuid } from "./common.js";

/**
 * The vault (secrets.md §5). A credential the firm holds: a client's, the firm's own, or one
 * person's.
 *
 * **Every secret has a template**, and a template decides its fields. They come in two halves:
 *
 * - **open fields** say WHAT a secret is — a site, a bank, an agency, a tax year. They are readable
 *   by anyone who may see the place it sits in, they are what the list shows and the search reads,
 *   and they live in plain columns;
 * - **secret fields** are sealed together as one object into the row's ciphertext. They are never in
 *   a list, a search or a log, and revealing opens all of an entry's secret fields at once.
 *
 * A login is a secret field in every template: EFTPS signs in with an EIN or an SSN. And any
 * template may hold no secret values at all, which is the pointer-only entry the module has had
 * since S7.5: the description says where the credential really lives.
 */
export const SECRET_TEMPLATES = [
  "free_form",
  "login",
  "tax_account",
  "ip_pin",
  "bank",
  "id_document",
  "device",
  "payment_card",
] as const;
export type SecretTemplate = (typeof SECRET_TEMPLATES)[number];

/** What each template is called, and the one line under it when somebody picks one. */
export const TEMPLATE_COPY: Record<SecretTemplate, { label: string; hint: string }> = {
  free_form: { label: "Free form", hint: "A title, a description and one value" },
  login: { label: "Login", hint: "A site, software or mailbox" },
  tax_account: { label: "Tax account", hint: "IRS, EFTPS or a state" },
  ip_pin: { label: "IP PIN", hint: "The IRS's 6-digit PIN for one year" },
  bank: { label: "Bank", hint: "Routing, account and online banking" },
  id_document: { label: "ID document", hint: "Driver's license, state ID, passport" },
  device: { label: "Office Wi-Fi and device", hint: "The Wi-Fi, the router, the printer" },
  payment_card: { label: "Payment card", hint: "Number, expiry and CVV" },
};

export const TAX_AGENCIES = [
  "IRS online account",
  "IRS e-Services",
  "EFTPS",
  "State tax department",
  "Other",
] as const;
export const IP_PIN_WHO = ["taxpayer", "spouse", "dependent"] as const;
export const ID_DOCUMENT_TYPES = ["Driver's license", "State ID", "Passport", "Other"] as const;
export const CARD_BRANDS = [
  "Visa",
  "Mastercard",
  "American Express",
  "Discover",
  "Other",
] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

// ── the numbers people mistype ───────────────────────────────────────────────

/** A card number's own check digit. A mistyped card is refused at once, not at the till. */
export function luhnOk(cardNumber: string): boolean {
  const d = cardNumber.replace(/\D/g, "");
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** The brand, from the number itself: it decides the CVV's length, and it is all a list shows. */
export function brandOfCard(cardNumber: string): CardBrand {
  const d = cardNumber.replace(/\D/g, "");
  if (/^3[47]/.test(d)) return "American Express";
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(d)) return "Mastercard";
  if (/^6(011|5)/.test(d)) return "Discover";
  return "Other";
}

/** The only digits of a card that ever leave the vault's ciphertext. */
export const lastFourOfCard = (cardNumber: string) => cardNumber.replace(/\D/g, "").slice(-4);

const cvvLengthFor = (brand: CardBrand) => (brand === "American Express" ? 4 : 3);

// ── a template's two halves ──────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
const exactDigits = (n: number, message: string) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${n}}$`), message);

/**
 * The OPEN fields, which the list shows and the search reads. Strict objects: a field the template
 * does not declare is refused rather than quietly stored.
 */
const OPEN_FIELDS = {
  free_form: z.strictObject({}),
  login: z.strictObject({ site: text(200).optional() }),
  tax_account: z
    .strictObject({ agency: z.enum(TAX_AGENCIES), state: text(80).optional() })
    .refine((o) => o.agency !== "State tax department" || !!o.state?.trim(), {
      message: "Name the state",
      path: ["state"],
    }),
  // the IRS issues a new one every year, so the year is what tells two of them apart
  ip_pin: z.strictObject({
    year: exactDigits(4, "A tax year, like 2026"),
    who: z.enum(IP_PIN_WHO),
    firstName: text(80).optional(),
  }),
  bank: z.strictObject({ bank: text(120).optional() }),
  id_document: z.strictObject({
    docType: z.enum(ID_DOCUMENT_TYPES),
    issuer: text(80).optional(),
  }),
  device: z.strictObject({ device: text(120).optional() }),
  // `brand` and `last4` are COMPUTED from the number when it is sealed (§5.3), never sent
  payment_card: z.strictObject({}),
} as const;

/**
 * The SECRET fields, sealed together as one object. Every one of them is optional: a template with
 * none filled in is a pointer-only entry, which is a first-class choice rather than a mistake.
 */
const SECRET_FIELDS = {
  free_form: z.strictObject({ value: text(10_000).optional() }),
  login: z.strictObject({
    login: text(200).optional(),
    password: text(500).optional(),
    recovery: text(2000).optional(),
    twofa: text(200).optional(),
    notes: text(2000).optional(),
  }),
  tax_account: z.strictObject({
    idNumber: text(60).optional(),
    login: text(200).optional(),
    password: text(500).optional(),
    pin: text(60).optional(),
    notes: text(2000).optional(),
  }),
  ip_pin: z.strictObject({ pin: exactDigits(6, "An IP PIN is exactly 6 digits").optional() }),
  bank: z.strictObject({
    routing: exactDigits(9, "A routing number is 9 digits").optional(),
    account: text(60).optional(),
    login: text(200).optional(),
    password: text(500).optional(),
    notes: text(2000).optional(),
  }),
  id_document: z.strictObject({
    number: text(60).optional(),
    issued: text(20).optional(),
    expires: text(20).optional(),
  }),
  device: z.strictObject({
    password: text(500).optional(),
    adminLogin: text(200).optional(),
    adminPassword: text(500).optional(),
    notes: text(2000).optional(),
  }),
  /**
   * **A card PIN is not here, and cannot be added by a caller** (§5.3): a payment without the card
   * present never needs one, and a strict object refuses the field. The CVV is here at the owner's
   * request, sealed with the rest; PCI DSS is what §5.3 says about it.
   */
  payment_card: z
    .strictObject({
      number: text(30).optional(),
      holder: text(120).optional(),
      expiry: z
        .string()
        .trim()
        .regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "MM/YY")
        .optional(),
      cvv: exactDigits(3, "3 digits, or 4 on American Express")
        .or(exactDigits(4, "3 digits, or 4 on American Express"))
        .optional(),
      notes: text(2000).optional(),
    })
    .refine((s) => !s.number || luhnOk(s.number), {
      message: "This card number is not valid",
      path: ["number"],
    })
    // two rules rather than one message built at the time: the length a card wants is decided by
    // its brand, and the brand comes from the number itself
    .refine(
      (s) =>
        !s.cvv ||
        !s.number ||
        brandOfCard(s.number) !== "American Express" ||
        s.cvv.length === cvvLengthFor("American Express"),
      { message: "4 digits on American Express", path: ["cvv"] },
    )
    .refine(
      (s) =>
        !s.cvv ||
        !s.number ||
        brandOfCard(s.number) === "American Express" ||
        s.cvv.length === cvvLengthFor("Visa"),
      { message: "3 digits", path: ["cvv"] },
    ),
} as const;

const forTemplate = <T extends SecretTemplate>(template: T) =>
  z.strictObject({
    template: z.literal(template),
    label: z.string().trim().min(1).max(120),
    description: text(2000).nullable().optional(),
    open: OPEN_FIELDS[template],
    /**
     * Omitted on edit = leave the stored values alone; explicit `null` = drop them and keep the
     * entry as a pointer. An object with nothing in it means the same as `null`.
     */
    secret: SECRET_FIELDS[template].nullable().optional(),
  });

/**
 * What a save sends. The template is part of the body because it decides every other field, and a
 * PATCH that names a different one than the row holds is refused by the service: a template is fixed
 * once saved (§3.3, decision 11), and mapping fields between templates would be guesswork with
 * credentials.
 */
export const secretInput = z.discriminatedUnion("template", [
  forTemplate("free_form"),
  forTemplate("login"),
  forTemplate("tax_account"),
  forTemplate("ip_pin"),
  forTemplate("bank"),
  forTemplate("id_document"),
  forTemplate("device"),
  forTemplate("payment_card"),
]);
export type SecretInput = z.infer<typeof secretInput>;

/** A secret as a list shows it: its open half, and whether anything is sealed under it. */
export const secretSchema = z.object({
  id: uuid,
  template: z.enum(SECRET_TEMPLATES),
  label: z.string().min(1),
  description: z.string().nullable(),
  /** the template's open fields, exactly as they were saved */
  fields: z.record(z.string(), z.string()),
  /** false = a pointer-only entry: nothing is stored, the description says where it lives */
  hasValue: z.boolean(),
  /** "Olena Petrenko (personal)" on a secret a leaver's block moved into Company (§8); else null */
  movedFromName: z.string().nullable(),
  createdByName: z.string().nullable(),
  /** who changed it last, or who made it when nobody has since */
  updatedByName: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type SecretRow = z.infer<typeof secretSchema>;

/**
 * Where a move sends a secret (§7). `personal` is always the CALLER's own My secrets: nobody may
 * put a credential into somebody else's private list.
 */
export const secretPlaceInput = z.discriminatedUnion("space", [
  z.strictObject({ space: z.literal("personal") }),
  z.strictObject({ space: z.literal("company") }),
  z.strictObject({ space: z.literal("client"), clientId: uuid }),
]);
export type SecretPlaceInput = z.infer<typeof secretPlaceInput>;

/** A selection stays within one place, and a bulk move asks once, with the count (§7). */
/** A selection names each secret once; a repeat would read as one that is not there any more. */
const selection = z
  .array(uuid)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "A secret is named twice");

export const moveSecretsInput = z.strictObject({
  ids: selection,
  to: secretPlaceInput,
});
export type MoveSecretsInput = z.infer<typeof moveSecretsInput>;

/** Several secrets from one place into the Trash as ONE gesture, which Undo takes back whole (§9). */
export const deleteSecretsInput = z.strictObject({ ids: selection });
export type DeleteSecretsInput = z.infer<typeof deleteSecretsInput>;

// ── the search (§10) ─────────────────────────────────────────────────────────

export const secretSearchQuery = z.object({
  q: z.string().trim().max(200).default(""),
  place: z.enum(["my", "company", "clients"]).optional(),
  template: z.enum(SECRET_TEMPLATES).optional(),
});
export type SecretSearchQuery = z.infer<typeof secretSearchQuery>;

/**
 * One step of a hit's path, and where a click on it goes (§10, as `files.md` §13): a fixed place,
 * the Clients list, or one client. The last step opens the list and marks the secret in it.
 */
export interface SecretCrumb {
  label: string;
  to:
    | { type: "my" }
    | { type: "company" }
    | { type: "clients" }
    | { type: "client"; clientId: string };
}

export interface SecretHit {
  id: string;
  template: SecretTemplate;
  label: string;
  description: string | null;
  fields: Record<string, string>;
  hasValue: boolean;
  updatedAt: string;
  /** where it is, in words: "Clients › Petrenko Olena" */
  path: string;
  /** the same path step by step, each step with where it leads */
  crumbs: SecretCrumb[];
}

export interface SecretSearchPage {
  hits: SecretHit[];
  /** live clients whose name or code matches: the way to one that holds no secrets yet */
  clients: { id: string; label: string; code: number; secrets: number }[];
}

/** One look at a secret's own journal: who did what to it, and when (§11). */
export interface SecretHistoryRow {
  id: string;
  action: string;
  byName: string;
  createdAt: string;
}

/** Re-authentication: the viewer's OWN login password, for a five-minute grant on the whole vault. */
export const unlockVaultInput = z.object({ password: z.string().min(1).max(200) });
export type UnlockVaultInput = z.infer<typeof unlockVaultInput>;

/** `expiresAt` null = locked. The countdown on screen reads the server's number, never its own. */
export const vaultGrantSchema = z.object({ expiresAt: z.iso.datetime().nullable() });

/** One reveal opens ALL of an entry's secret fields, and counts as one look in the journal (§6). */
export const revealedSecretSchema = z.object({
  secret: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type RevealedSecret = z.infer<typeof revealedSecretSchema>;
