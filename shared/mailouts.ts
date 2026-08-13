/**
 * Merge variables for client mailouts — the catalog and the renderer.
 *
 * Zod-free and dependency-free on purpose, like `shared/meetings.ts`: the composer previews a
 * letter against a real client on every keystroke, and must not pull the schema runtime into the
 * browser bundle to do it.
 *
 * The point of putting this in `shared/` is **parity**. The preview the firm proofreads and the
 * letter the client receives come out of this one function, so "it looked right in the preview"
 * is a claim about the actual send rather than about a second implementation that resembles it.
 */

/** `{{ first_name }}` — spaces tolerated, since people type them. */
const VAR_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * What a letter may reference.
 *
 * `required: true` means an empty value makes the letter wrong rather than merely plainer — a
 * greeting reading "Hello ," is worse than no letter at all, so a recipient missing one of these
 * is skipped and named in the log instead of being sent a broken message.
 *
 * `required: false` values are firm-level constants: they come from Settings, are identical for
 * every recipient, and their absence is the firm's own configuration gap, not a data gap.
 */
export interface MailVariable {
  key: string;
  label: string;
  /** what it renders to for the sample client shown in the template editor */
  sample: string;
  required: boolean;
}

export const CLIENT_VARIABLES: readonly MailVariable[] = [
  { key: "first_name", label: "First name", sample: "Olena", required: true },
  { key: "last_name", label: "Last name", sample: "Kovalenko", required: true },
  { key: "full_name", label: "Full name", sample: "Olena Kovalenko", required: true },
  { key: "company", label: "Company", sample: "Kvitka Trade LLC", required: true },
  { key: "email", label: "Email", sample: "olena@example.com", required: true },
  { key: "phone", label: "Phone", sample: "+1 (704) 555-0142", required: true },
  { key: "address", label: "Address", sample: "1200 Main St, Charlotte, NC", required: true },
] as const;

/**
 * Deliberately only what Settings can actually fill.
 *
 * `{{firm_phone}}` and `{{firm_site}}` are NOT here: the firm has no field for either, so offering
 * them would put a variable in the picker that silently renders to nothing. Both already appear in
 * the signature block at the foot of every letter, which is what that block is for.
 */
export const FIRM_VARIABLES: readonly MailVariable[] = [
  { key: "firm_name", label: "Firm name", sample: "ILLION Tax & Accounting", required: false },
  { key: "firm_email", label: "Firm email", sample: "info@illion.tax", required: false },
] as const;

export const MAIL_VARIABLES: readonly MailVariable[] = [...CLIENT_VARIABLES, ...FIRM_VARIABLES];

const BY_KEY = new Map(MAIL_VARIABLES.map((v) => [v.key, v]));

export type MailVars = Record<string, string | null | undefined>;

/**
 * Sentinels that fence a substituted value, so the preview can colour it in.
 *
 * Unicode private-use characters, chosen for three reasons: HTML escaping leaves them alone, so
 * they survive the trip through the layout intact; no real letter contains them; and they are
 * *characters*, not markup, so the escaping still happens on the client's actual data rather than
 * around an injected tag.
 *
 * Emitted only when `mark: true` is asked for — a real send never sees them.
 */
export const MARK_START = "";
export const MARK_END = "";

export interface RenderOptions {
  /** fence each substituted value with MARK_START/MARK_END, for the preview's highlighting */
  mark?: boolean;
}

export interface RenderResult {
  text: string;
  /** required variables the letter uses but this recipient has no value for */
  missing: string[];
  /** `{{typos}}` — referenced but not in the catalog. Left verbatim so they are visible. */
  unknown: string[];
}

/**
 * Substitute `{{vars}}`.
 *
 * A missing REQUIRED value is reported, not papered over — the caller decides, and the send path
 * always decides to skip that recipient. An unknown name is left standing as literal
 * `{{whatever}}` text: silently deleting it would hide the typo until a client saw the gap.
 */
export function renderMailText(
  template: string,
  vars: MailVars,
  opts: RenderOptions = {},
): RenderResult {
  const missing = new Set<string>();
  const unknown = new Set<string>();

  const text = template.replace(VAR_PATTERN, (whole, key: string) => {
    const spec = BY_KEY.get(key);
    if (!spec) {
      unknown.add(key);
      return whole;
    }
    const value = vars[key];
    if (value === null || value === undefined || value.trim() === "") {
      if (spec.required) missing.add(key);
      return "";
    }
    return opts.mark ? `${MARK_START}${value}${MARK_END}` : value;
  });

  return { text, missing: [...missing], unknown: [...unknown] };
}

/** Drop the fences, leaving the plain value. For anywhere a marked render must read as normal. */
export function stripMarks(text: string): string {
  return text.replaceAll(MARK_START, "").replaceAll(MARK_END, "");
}

/** Every variable a letter references, in catalog order. Drives the editor's "uses:" hint. */
export function usedVariables(...templates: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const t of templates) {
    for (const m of (t ?? "").matchAll(VAR_PATTERN)) found.add(m[1]);
  }
  return MAIL_VARIABLES.filter((v) => found.has(v.key)).map((v) => v.key);
}

/** The sample values behind the template editor's preview. */
export function sampleVars(): MailVars {
  return Object.fromEntries(MAIL_VARIABLES.map((v) => [v.key, v.sample]));
}
