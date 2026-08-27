import { readFileSync } from "node:fs";
import { prisma, disconnectDb } from "../server/core/db.js";
import { createClient, createSecret } from "../server/modules/clients/index.js";
import { clean, identityKey, normalisePhone, parseCsv, phoneKey } from "./import-lib.js";

/**
 * Import a CONTACTS export (name / email / state / phone) into a CRM that already holds clients.
 *
 *   docker compose exec -T app npx tsx scripts/import-contacts.ts --dry-run < contacts.csv
 *   docker compose exec -T app npx tsx scripts/import-contacts.ts           < contacts.csv
 *
 * Unlike `import-clients.ts`, which filled an EMPTY system, this one lands on top of 177 existing
 * clients and 42% of its rows are people already there. So its real work is telling those apart.
 *
 * **It only ever CREATES** (user, 2026-08-27). A row that matches an existing client is skipped
 * whole — no field is filled in, no name is corrected, nothing is touched. That decision is what
 * makes the ambiguous cases safe: two Garryyevs share an email and a phone and are two people, and
 * one row carries the same address as an existing client under a different surname. None of them
 * can be damaged by an import that writes nothing to anyone who already exists.
 */

// ── what counts as "already in the system" ──────────────────────────────────

/**
 * Deliberately GENEROUS: email, phone, or a full first+last name is each enough on its own.
 *
 * The asymmetry is on purpose. Skipping someone who turns out to be new costs a line in the report
 * and a minute of typing; creating a second card for someone who is already there costs a split
 * history that nobody notices until an invoice goes to the wrong one. The report names every skip
 * so the first kind of mistake is visible.
 *
 * A single first name is NOT enough — "Артем" and "Наталья" are not identities.
 */
interface Identity {
  emails: Set<string>;
  phones: Set<string>;
  names: Set<string>;
}

function indexOf(rows: { firstName: string; lastName: string | null; email: string | null; phone: string | null }[]): Identity {
  const id: Identity = { emails: new Set(), phones: new Set(), names: new Set() };
  for (const r of rows) {
    if (r.email) id.emails.add(identityKey(r.email));
    if (r.phone && phoneKey(r.phone)) id.phones.add(phoneKey(r.phone));
    if (r.firstName && r.lastName) id.names.add(identityKey(`${r.firstName} ${r.lastName}`));
  }
  return id;
}

// ── the export's own shape ──────────────────────────────────────────────────

const US_STATES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ " +
   "NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split(" "),
);

/** Spelled-out states appear beside their codes in the same column. */
const STATE_NAMES: Record<string, string> = {
  california: "CA", minnesota: "MN", florida: "FL", texas: "TX", newyork: "NY",
  pennsylvania: "PA", washington: "WA", arizona: "AZ", virginia: "VA", tennessee: "TN",
  northcarolina: "NC", southcarolina: "SC", massachusetts: "MA", illinois: "IL",
  kansas: "KS", wyoming: "WY",
};

/**
 * The column holds `CA`, `ca`, `California` — and `USA`, which is a country and not an answer to
 * "which state". A value that names no state is dropped rather than stored as one.
 */
function normaliseState(raw: string): string | null {
  const s = clean(raw);
  if (!s) return null;
  const up = s.toUpperCase();
  if (US_STATES.has(up)) return up;
  const spelled = STATE_NAMES[s.toLowerCase().replace(/\s+/g, "")];
  return spelled ?? null;
}

const EMAIL = /^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/;

interface Draft {
  line: number;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** a real SSN found in the export — goes to the encrypted store, never to a plain field */
  ssn: string | null;
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--"));
  const [header, ...body] = parseCsv(readFileSync(path ?? 0, "utf8"));
  if (!header) throw new Error("the CSV is empty");

  const col = (name: string) => {
    const i = header.findIndex((h) => clean(h) === name);
    if (i === -1) throw new Error(`the CSV has no "${name}" column — headers: ${header.join(", ")}`);
    return i;
  };
  const at = {
    first: col("First Name"),
    last: col("Last Name"),
    email: col("Email"),
    state: col("State / Province"),
    phone: col("Phone Numbers"),
    // the export carries this column TWICE, identically; the first is enough
    ssn: header.findIndex((h) => clean(h) === "SSN"),
  };
  const cell = (row: string[], i: number) => (i >= 0 && i < row.length ? clean(row[i]) : "");

  // ── read ──────────────────────────────────────────────────────────────────
  const drafts: Draft[] = [];
  const noName: number[] = [];
  body.forEach((row, i) => {
    const line = i + 2;
    const firstName = cell(row, at.first);
    if (!firstName) { noName.push(line); return; }
    const rawEmail = cell(row, at.email).toLowerCase();
    drafts.push({
      line,
      firstName,
      lastName: cell(row, at.last) || null,
      email: EMAIL.test(rawEmail) ? rawEmail : null,
      phone: normalisePhone(cell(row, at.phone)),
      address: normaliseState(cell(row, at.state)),
      ssn: cell(row, at.ssn) || null,
    });
  });

  // ── against what is already there ────────────────────────────────────────
  const existingRows = await prisma.client.findMany({
    where: { archivedAt: null },
    select: { firstName: true, lastName: true, email: true, phone: true },
  });
  const existing = indexOf(existingRows);

  const matchOf = (d: Draft): string | null => {
    if (d.email && existing.emails.has(identityKey(d.email))) return "email";
    if (d.phone && existing.phones.has(phoneKey(d.phone))) return "phone";
    if (d.lastName && existing.names.has(identityKey(`${d.firstName} ${d.lastName}`))) return "name";
    return null;
  };

  const skipped: [Draft, string][] = [];
  const candidates: Draft[] = [];
  for (const d of drafts) {
    const why = matchOf(d);
    if (why) skipped.push([d, why]);
    else candidates.push(d);
  }

  // ── and against each other ───────────────────────────────────────────────
  // The export holds the same person twice under two spellings, findable only by a shared email or
  // phone. Merging on those is right HERE, where both rows are new: the two-people-one-mailbox case
  // was caught by the pass above, because at least one of them already exists.
  const seen = new Map<string, Draft>();
  const fresh: Draft[] = [];
  const merged: [Draft, Draft][] = [];
  for (const d of candidates) {
    const key = d.email
      ? `e:${identityKey(d.email)}`
      : d.phone
        ? `p:${phoneKey(d.phone)}`
        : `n:${identityKey(`${d.firstName} ${d.lastName ?? ""}`)}`;
    const first = seen.get(key);
    if (first) {
      first.email ??= d.email;
      first.phone ??= d.phone;
      first.address ??= d.address;
      first.ssn ??= d.ssn;
      merged.push([d, first]);
      continue;
    }
    seen.set(key, d);
    fresh.push(d);
  }

  // ── report ───────────────────────────────────────────────────────────────
  const filled = (f: keyof Draft) => fresh.filter((d) => d[f]).length;
  console.log(`rows read            : ${body.length}`);
  if (noName.length) console.log(`  no name, skipped   : ${noName.length} (lines ${noName.join(", ")})`);
  console.log(`already in the system: ${skipped.length}`);
  for (const [d, why] of skipped) {
    console.log(`    line ${String(d.line).padStart(3)}  ${`${d.firstName} ${d.lastName ?? ""}`.trim().padEnd(28)} — matched on ${why}`);
  }
  console.log(`merged within the file: ${merged.length}`);
  for (const [dup, into] of merged) {
    console.log(`    line ${String(dup.line).padStart(3)}  ${`${dup.firstName} ${dup.lastName ?? ""}`.trim().padEnd(28)} → line ${into.line}`);
  }
  console.log(`\nto create            : ${fresh.length}`);
  for (const f of ["lastName", "email", "phone", "address"] as const) {
    console.log(`  ${f.padEnd(10)} filled: ${filled(f)}/${fresh.length}`);
  }

  const withSsn = fresh.filter((d) => d.ssn);
  const ssnSkipped = skipped.filter(([d]) => d.ssn);
  console.log(`\nSSNs to store encrypted: ${withSsn.length}`);
  for (const d of withSsn) console.log(`    ${`${d.firstName} ${d.lastName ?? ""}`.trim()}`);
  if (ssnSkipped.length) {
    console.log(`SSNs NOT stored — the client already exists and is never touched: ${ssnSkipped.length}`);
    for (const [d] of ssnSkipped) {
      console.log(`    ${`${d.firstName} ${d.lastName ?? ""}`.trim()} — add it by hand on their Secrets tab`);
    }
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing was written.");
    return;
  }

  const actor = await prisma.user.findFirst({ where: { role: "admin", status: "active" } });
  if (!actor) throw new Error("no active admin to attribute the import to");

  let created = 0;
  let secrets = 0;
  const failed: string[] = [];
  for (const d of fresh) {
    const who = `${d.firstName} ${d.lastName ?? ""}`.trim();
    try {
      const client = await createClient({
        firstName: d.firstName,
        lastName: d.lastName,
        companyName: null,
        phone: d.phone,
        email: d.email,
        address: d.address,
        sourceId: null,
        description: null,
        companies: [],
        people: [],
      });
      created++;
      if (d.ssn) {
        // never a plain field: encrypted at rest, admin-only reveal, and the access is journalled
        await createSecret(
          client.id,
          { label: "SSN", description: "Imported from the contacts export, 2026-08-27", value: d.ssn },
          actor,
          null,
        );
        secrets++;
      }
    } catch (err) {
      failed.push(`line ${d.line} "${who}": ${String(err)}`);
    }
  }

  console.log(`\ncreated: ${created}/${fresh.length}`);
  console.log(`secrets: ${secrets}`);
  if (failed.length) {
    console.log(`failed : ${failed.length}`);
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
