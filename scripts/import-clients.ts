import { readFileSync } from "node:fs";
import { prisma, disconnectDb } from "../server/core/db.js";
import { clean, normalisePhone, parseCsv } from "./import-lib.js";
import { createClient } from "../server/modules/clients/index.js";

/**
 * One-off import of the firm's Numbers/Airtable client sheet into an empty CRM (2026-08-26).
 *
 *   docker compose exec -T app npx tsx scripts/import-clients.ts --dry-run < clients.csv
 *   docker compose exec -T app npx tsx scripts/import-clients.ts           < clients.csv
 *
 * Reads the CSV on stdin (or a path argument) so the sheet — which is nothing but client personal
 * data — never has to be committed or left on the server.
 *
 * Goes through `createClient`, not raw SQL, so an imported client is indistinguishable from one
 * typed into the form: the same validation, the same "every client gets the default one-time
 * service" subscription, the same audit shape. Only `createdAt` is written afterwards, because
 * the sheet knows when each client actually arrived and the service layer (rightly) does not let
 * a caller choose.
 */

// ── field cleaning ──────────────────────────────────────────────────────────

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;
const URL = /https?:\/\/\S+/g;
const TG_HANDLE = /(?<![\w@./])@([A-Za-z0-9_]{3,32})\b/g;

/** Calendar entries that leaked into the client sheet — a slot and a name, nothing else. */
const NOT_A_CLIENT = new Set(["тренировка", "врач", "созвон с игорем"]);

/** Names that are a pair or a business, not "first last" — split would invent a surname. */
const KEEP_WHOLE = /[/+]|\sи\s|\bLLC\b|бухгалтери|партнерств/i;

const US_STATES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ " +
   "NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split(" "),
);

/** The sheet's own source labels → the SourceOption names the CRM will hold. */
const SOURCE_MAP: Record<string, string> = {
  "Facebook Ad": "Facebook Ad",
  Telegram: "Telegram",
  Instagram: "Instagram",
  "Phone Call": "Phone Call",
  Referral: "Referral",
  Website: "Website",
  "Networking Event": "Event",
  видео: "Video",
};

function splitName(raw: string): { firstName: string; lastName: string | null } {
  const n = clean(raw);
  if (KEEP_WHOLE.test(n)) return { firstName: n, lastName: null };
  const at = n.indexOf(" ");
  return at === -1
    ? { firstName: n, lastName: null }
    : { firstName: n.slice(0, at), lastName: n.slice(at + 1) };
}

/** "Fl Hallandale Beach" → "FL, Hallandale Beach"; "Nashville TN" → "TN, Nashville". */
function normaliseAddress(raw: string): string | null {
  let s = clean(raw);
  if (!s) return null;
  s = s.replace("Штат Техас, Хьюстон", "TX, Houston").replace("Казахстан", "Kazakhstan");
  const lead = /^([A-Za-z]{2})\b[.,]?\s*(.*)$/.exec(s);
  if (lead && US_STATES.has(lead[1].toUpperCase())) {
    const rest = clean(lead[2]);
    return rest ? `${lead[1].toUpperCase()}, ${titleIfLower(rest)}` : lead[1].toUpperCase();
  }
  const trail = /^(.*)\s+([A-Za-z]{2})$/.exec(s);
  if (trail && US_STATES.has(trail[2].toUpperCase())) {
    return `${trail[2].toUpperCase()}, ${clean(trail[1])}`;
  }
  return s;
}

const titleIfLower = (s: string) =>
  s === s.toLowerCase() ? s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s;

/** The export wraps a cell that contains a comma in its own quotes, which survive parsing. */
const unquote = (s: string) => s.replace(/^"+|"+$/g, "").trim();

/** "Tax Preparation (Individual),Tax Preparation (Business)" → the two labels, quotes stripped. */
function splitServices(raw: string): string[] {
  const s = unquote(clean(raw));
  if (!s) return [];
  return s
    .split(/,(?![^()]*\))/)
    .map((p) => unquote(p))
    .filter(Boolean);
}

function parseSheetDate(raw: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(am|pm))?$/i.exec(clean(raw));
  if (!m) return null;
  const [, mo, d, y, hh, mi, ap] = m;
  let hour = hh ? Number(hh) % 12 : 0;
  if (ap?.toLowerCase() === "pm") hour += 12;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi ?? 0)));
}

// ── row → client ────────────────────────────────────────────────────────────

interface Draft {
  line: number;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  sourceName: string | null;
  description: string | null;
  createdAt: Date;
}

function toDraft(get: (c: string) => string, line: number): Draft {
  const contact = clean(get("Contact Info"));
  const phoneCell = clean(get("Phone"));

  const email = (EMAIL.exec(contact) ?? EMAIL.exec(phoneCell))?.[0].toLowerCase() ?? null;

  let phone = normalisePhone(phoneCell);
  // a number that was typed into Contact Info instead
  if (!phone) {
    const inContact = /(\+?\d[\d\-\s().]{8,}\d)/.exec(contact);
    if (inContact) phone = normalisePhone(inContact[1]);
  }

  // Everything the CRM has no column for is preserved as a description block rather than dropped.
  // The sheet is the only record of it, and the accountant reads these lines.
  const notes: string[] = [];
  const handles = [...contact.matchAll(TG_HANDLE)].map((m) => `@${m[1]}`);
  const links = [...contact.matchAll(URL)].map((m) => m[0]);
  if (/^https?:/i.test(phoneCell)) links.push(phoneCell);
  if (handles.length) notes.push(`Telegram: ${handles.join(", ")}`);
  if (links.length) notes.push(`Соцмережі: ${links.join(" ")}`);
  if (contact && !email && !handles.length && !links.length && !/^[+\d][\d\-\s().]+$/.test(contact)) {
    notes.push(`Контакт: ${contact}`);
  }

  const services = splitServices(get("Service Type"));
  if (services.length) notes.push(`Послуги (з таблиці): ${services.join(", ")}`);
  const clientType = clean(get("Client Type"));
  if (clientType) notes.push(`Тип (з таблиці): ${clientType}`);
  const quoted = clean(get("Quated"));
  if (quoted) notes.push(`Ціна (з таблиці): ${quoted}`);
  if (clean(get("Договор подписан"))) notes.push("Договір підписано ✓");

  const task = unquote(clean(get("Tasks")));
  const deadline = clean(get("Deadline"));
  if (task && task !== "Unnamed record") {
    notes.push(`Завдання (з таблиці): ${task}${deadline ? ` — дедлайн ${deadline}` : ""}`);
  } else if (deadline) {
    notes.push(`Дедлайн (з таблиці): ${deadline}`);
  }
  const appointment = parseSheetDate(get("Appointment"));
  if (appointment) {
    notes.push(
      `Остання зустріч (з таблиці): ${appointment.toISOString().slice(0, 16).replace("T", " ")}`,
    );
  }

  const free = unquote((get("Notes") ?? "").trim());
  const description = [notes.join("\n"), free].filter(Boolean).join("\n\n").trim() || null;

  return {
    line,
    ...splitName(get("Client Name")),
    email,
    phone,
    address: normaliseAddress(get("Client Address")),
    sourceName: SOURCE_MAP[clean(get("Source"))] ?? null,
    description,
    createdAt: parseSheetDate(get("Date Added")) ?? new Date(),
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--"));
  const text = readFileSync(path ?? 0, "utf8");

  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error("the CSV is empty");
  const col = (name: string) => {
    const i = header.findIndex((h) => clean(h) === name);
    if (i === -1) throw new Error(`the CSV has no "${name}" column — headers: ${header.join(", ")}`);
    return i;
  };
  const idx = Object.fromEntries(
    ["Client Name", "Client Type", "Service Type", "Deadline", "Tasks", "Appointment",
     "Contact Info", "Phone", "Client Address", "Notes", "Quated", "Date Added",
     "Договор подписан", "Source"].map((n) => [n, col(n)]),
  );

  const drafts: Draft[] = [];
  const dropped: string[] = [];
  const byIdentity = new Map<string, Draft>();

  body.forEach((row, i) => {
    const line = i + 2;
    const get = (c: string) => row[idx[c]] ?? "";
    const name = clean(get("Client Name"));
    if (!name) { dropped.push(`line ${line}: no name`); return; }
    if (NOT_A_CLIENT.has(name.toLowerCase())) {
      dropped.push(`line ${line}: "${name}" — a calendar entry, not a client`);
      return;
    }

    const draft = toDraft(get, line);
    // The sheet was edited by hand for months; the same person was entered twice. Same name AND
    // same phone is the only pair safe to merge — two Garryyevs share a phone but are two people.
    const key = `${name.toLowerCase()}|${(draft.phone ?? "").slice(-10)}`;
    const seen = draft.phone || draft.email ? byIdentity.get(key) : undefined;
    if (seen) {
      seen.email ??= draft.email;
      seen.address ??= draft.address;
      seen.sourceName ??= draft.sourceName;
      if (draft.description) {
        seen.description = `${seen.description ?? ""}\n\n— дубль рядка ${line} —\n${draft.description}`.trim();
      }
      if (draft.createdAt < seen.createdAt) seen.createdAt = draft.createdAt;
      dropped.push(`line ${line}: "${name}" — merged into line ${seen.line} (same name + phone)`);
      return;
    }
    byIdentity.set(key, draft);
    drafts.push(draft);
  });

  const filled = (f: keyof Draft) => drafts.filter((d) => d[f]).length;
  console.log(`rows read        : ${body.length}`);
  console.log(`clients to import: ${drafts.length}`);
  console.log(`dropped / merged : ${dropped.length}`);
  for (const d of dropped) console.log(`    ${d}`);
  for (const f of ["lastName", "email", "phone", "address", "sourceName", "description"] as const) {
    console.log(`  ${f.padEnd(12)} filled: ${filled(f)}/${drafts.length}`);
  }

  const defaultService = await prisma.service.findFirst({
    where: { autoAddToNewClients: true, active: true, type: "one_time" },
  });
  console.log(
    defaultService
      ? `default service  : "${defaultService.name}" — every client gets it as a subscription`
      : "default service  : ⚠ NONE is flagged — imported clients will have no service at all",
  );

  const existing = await prisma.client.count();
  if (existing > 0 && !args.includes("--force")) {
    throw new Error(
      `the database already holds ${existing} client(s). Import into an empty CRM, or pass --force.`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing was written.");
    return;
  }

  // Source options the sheet needs and `ensureBaseData()` does not create.
  const names = [...new Set(drafts.map((d) => d.sourceName).filter((n): n is string => !!n))];
  const baseCount = await prisma.sourceOption.count();
  for (const [i, name] of names.entries()) {
    await prisma.sourceOption.upsert({
      where: { name },
      update: {},
      create: { name, order: baseCount + i },
    });
  }
  const sourceIds = new Map(
    (await prisma.sourceOption.findMany({ select: { id: true, name: true } })).map((s) => [
      s.name,
      s.id,
    ]),
  );

  let done = 0;
  const failed: string[] = [];
  for (const d of drafts) {
    try {
      const created = await createClient({
        firstName: d.firstName,
        lastName: d.lastName,
        companyName: null,
        phone: d.phone,
        email: d.email,
        address: d.address,
        sourceId: d.sourceName ? (sourceIds.get(d.sourceName) ?? null) : null,
        description: d.description,
        companies: [],
        people: [],
      });
      // the sheet knows when the client actually arrived; the service layer cannot be told
      await prisma.client.update({ where: { id: created.id }, data: { createdAt: d.createdAt } });
      done++;
    } catch (err) {
      const who = `${d.firstName} ${d.lastName ?? ""}`.trim();
      failed.push(`line ${d.line} "${who}": ${String(err)}`);
    }
  }

  console.log(`\nimported: ${done}/${drafts.length}`);
  if (failed.length) {
    console.log(`failed  : ${failed.length}`);
    for (const f of failed) console.log(`    ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => disconnectDb());
