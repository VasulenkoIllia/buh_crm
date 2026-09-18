/**
 * The vault — the credentials the firm holds (secrets.md §6, §9, §11).
 *
 * Three rules shape everything here:
 *   1. The value is encrypted at rest and NEVER leaves through a list endpoint.
 *   2. Revealing costs the viewer's OWN password and lasts five minutes — counted here, on the
 *      server, because a countdown in the browser is decoration.
 *   3. Every reveal, and every FAILED unlock, is journalled. A run of failures is the only signal
 *      that somebody is guessing.
 *
 * **One unlock opens the whole vault** (decision 2, 2026-09-15), which reverses the grant per
 * client of 2026-08-01. With three places and a firm-wide search, a grant per client asked for the
 * password on every second click, and a rule people meet that often is a rule they route around.
 * What protected the value was always the password step and the journal, and both stay.
 *
 * The grant belongs to the SESSION, not the person: unlocking on one computer opens nothing on
 * another. It lives in process memory rather than the database — a restart revoking every grant is
 * a feature, and there is exactly one app container.
 */
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import {
  brandOfCard,
  lastFourOfCard,
  type DeleteSecretsInput,
  type MoveSecretsInput,
  type SecretInput,
  type SecretTemplate,
  type UnlockVaultInput,
} from "@shared/schema/secrets.js";
import type { User } from "../../generated/prisma/client.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { open, seal, secretsConfigured } from "../../core/secrets-crypto.js";
import { diff, record } from "../../core/activity.js";
import { opens, readerOf, requireOpen, requireReadable } from "../files/index.js";
import { fileRowOf } from "./secrets.file-row.js";
import { trashWhere } from "./secrets.trash.js";
import * as repo from "./secrets.repository.js";
import type { Place } from "./secrets.repository.js";

const GRANT_MINUTES = 5;
const GRANT_MS = GRANT_MINUTES * 60_000;

/** session id → when its grant expires. Cleared by a restart, deliberately. */
const grants = new Map<string, number>();

export function activeGrant(sessionId: string | null): number | null {
  if (!sessionId) return null;
  const until = grants.get(sessionId);
  if (!until) return null;
  if (until <= Date.now()) {
    grants.delete(sessionId);
    return null;
  }
  return until;
}

// Secrets used to be admin-only (2026-08-01). They are not any more (user, 2026-08-14): everyone
// who works a client's file needs the portal login for it, and a rule that sends half the team to
// ask an admin every time is a rule people route around — by keeping the password somewhere else.
//
// What did NOT change is the part that actually protects the value: reading one still costs the
// viewer's own password, the grant still expires after five minutes, and every look and every
// failed attempt is still journalled with a name against it.

function assertConfigured(): void {
  if (!secretsConfigured()) {
    throw new ValidationError(
      "The secret vault is not configured. Set SECRETS_KEY on the server (openssl rand -base64 32)",
    );
  }
}

/**
 * **Which place, and what that means for the log** (§4.2, §11).
 *
 * A row in a client's list carries its `clientId`, so the client card's Activity tab finds it. My
 * secrets are logged by the ACT and never by the title: "stored a personal secret" is all a
 * colleague or an admin ever reads, which is what makes a private place private in a system that
 * records everything.
 */
const clientOf = (place: Place) => (place.space === "client" ? place.clientId : undefined);
const labelIn = (place: Place, label: string) =>
  place.space === "personal" ? "a personal secret" : label;

/** A client's list exists only while the client does, and an archived one is not shown. */
async function assertPlace(place: Place): Promise<void> {
  if (place.space === "client" && !(await repo.clientExists(place.clientId))) {
    throw new NotFoundError("Client not found");
  }
}

/**
 * **A client's secrets need Clients open as well as Secrets** (§4.3, §12).
 *
 * A route declares one gate, and this module's places are not static, so the second gate is asked
 * here — the named exception the library already has (`core/access.ts`, `files.access.ts`). Reading
 * a client's list needs Clients readable; writing into it needs Clients open.
 */
export async function clientPlace(
  user: User,
  clientId: string,
  intent: "read" | "write",
): Promise<Place> {
  const reader = await readerOf(user);
  if (intent === "write") requireOpen(reader, "clients");
  else requireReadable(reader, "clients");
  // an archived client's list is not shown anywhere (§4.2), so it cannot be read or written by
  // naming it either: the same answer as a client that does not exist (audit, 2026-09-16)
  if (!(await repo.clientExists(clientId))) throw new NotFoundError("Client not found");
  return { space: "client", clientId };
}

/**
 * **What the tree shows before anything is opened** (§4): how many secrets sit in each place, and
 * how many wait in the Trash. Clients is counted only for a reader who may open clients at all,
 * so a closed gate leaves no number to wonder about.
 */
export async function overview(user: User) {
  const reader = await readerOf(user);
  const clientsOpen = opens(reader, "clients");
  const [personal, company, clients, trash] = await Promise.all([
    repo.countWhere({ space: "personal", ownerId: user.id, deletedAt: null }),
    repo.countWhere({ space: "company", deletedAt: null }),
    clientsOpen
      ? repo.countWhere({
          space: "client",
          deletedAt: null,
          client: { is: { archivedAt: null } },
        })
      : Promise.resolve(0),
    repo.countWhere(await trashWhere(user)),
  ]);
  return { personal, company, clients, trash, clientsOpen };
}

/**
 * Every client that has a list, with how many secrets are in it: the Clients node, and the way to a
 * client that holds none yet. Needs Clients as well as Secrets, like any other read of a client.
 */
export async function clientNodes(user: User) {
  const reader = await readerOf(user);
  requireReadable(reader, "clients");
  const clients = await repo.liveClients();
  const counts = await repo.countByClient(clients.map((c) => c.id));
  return clients.map((c) => ({
    id: c.id,
    label: c.companyName || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "a client",
    code: c.code,
    secrets: counts.get(c.id) ?? 0,
  }));
}

/** The two places that are the same for everybody, and the one that is one person's. */
export const myPlace = (user: User): Place => ({ space: "personal", ownerId: user.id });
export const companyPlace = (): Place => ({ space: "company" });

/**
 * **The plain half of a save** (§5.1): the template's open fields, trimmed, plus the two a payment
 * card computes from its number. The brand decides the CVV's length and the last four are the only
 * digits a list ever shows; neither is ever sent by a caller.
 */
function openFieldsOf(
  input: SecretInput,
  stored?: Record<string, string>,
): Record<string, string> {
  const open: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.open as Record<string, string | undefined>)) {
    if (typeof value === "string" && value.trim()) open[key] = value.trim();
  }
  // a state names a state's tax department and nothing else (§5), whatever a caller sends
  if (input.template === "tax_account" && open.agency !== "State tax department") {
    delete open.state;
  }
  if (input.template === "payment_card") {
    // read through the shape rather than the union: only this template declares a card number, and
    // the schema has already refused it anywhere else
    const number = (input.secret as { number?: string } | null | undefined)?.number?.trim();
    if (number) {
      open.brand = brandOfCard(number);
      open.last4 = lastFourOfCard(number);
    } else if (input.secret === undefined && stored) {
      // an edit that does not touch the sealed half keeps the digits computed the last time
      if (stored.brand) open.brand = stored.brand;
      if (stored.last4) open.last4 = stored.last4;
    }
  }
  return open;
}

/** Only what somebody actually filled in. Nothing at all means a pointer-only entry. */
function filledSecret(input: SecretInput): Record<string, string> {
  const filled: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    (input.secret ?? {}) as Record<string, string | undefined>,
  )) {
    if (typeof value === "string" && value.trim()) filled[key] = value.trim();
  }
  return filled;
}

/**
 * **The sealed half, as one object** (§5.1, §13). A free-form entry keeps the plain string it has
 * held since S7.5, so no row from before the templates is ever re-encrypted; every other template
 * seals a JSON object of its secret fields, and one reveal opens all of them.
 *
 * `undefined` = the save did not touch the sealed half. `null` = drop it and keep the entry as a
 * pointer.
 */
function sealedFrom(input: SecretInput) {
  if (input.secret === undefined) return undefined;
  const filled = filledSecret(input);
  if (Object.keys(filled).length === 0) return null;
  assertConfigured();
  return seal(input.template === "free_form" ? filled.value : JSON.stringify(filled));
}

/** The sealed half of a stored row, opened. A free-form row is the one plain string (§13). */
function unsealSecret(row: {
  template: SecretTemplate;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}): Record<string, string> {
  const plaintext = open(row);
  if (row.template === "free_form") return { value: plaintext };
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
  } catch {
    // a row sealed before its template was templated: show it as the one value it is
  }
  return { value: plaintext };
}

/**
 * **Which secret fields moved, by NAME** (§11). It opens the stored half to compare them, and what
 * leaves this function is a list of names: the log has to answer "was the password rotated, or did
 * somebody fix a typo" without becoming a second copy of the vault.
 */
function changedSecretNames(
  row: {
    template: SecretTemplate;
    ciphertext: Uint8Array | null;
    iv: Uint8Array | null;
    authTag: Uint8Array | null;
    keyVersion: number;
  },
  input: SecretInput,
): string[] {
  const now = filledSecret(input);
  let before: Record<string, string> = {};
  if (row.ciphertext && row.iv && row.authTag) {
    try {
      before = unsealSecret({
        template: row.template,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      });
    } catch {
      // the key is gone or the row is damaged: name what this save carries, and claim no more
      return Object.keys(now);
    }
  }
  return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(
    (key) => (before[key] ?? "") !== (now[key] ?? ""),
  );
}

/**
 * Labels, descriptions and open fields for a client. Anyone who can open the client sees these —
 * knowing THAT a tax-portal login exists, and what it is for, is ordinary working knowledge; the
 * value is not.
 */
const nameOf = (who: { firstName: string; lastName: string } | null) =>
  who ? `${who.firstName} ${who.lastName}`.trim() : null;

/**
 * **The IRS issues a new IP PIN every year, so they sort by year** (§5), newest first. They keep the
 * places IP PINs hold in the list and change places only with each other, so the rest of the list
 * stays in the order it was made.
 */
function ipPinsByYear<T extends { template: string; fields: Record<string, string> }>(
  rows: T[],
) {
  const slots = rows.flatMap((row, i) => (row.template === "ip_pin" ? [i] : []));
  const pins = slots
    .map((i) => rows[i])
    .sort((a, b) => (Number(b.fields.year) || 0) - (Number(a.fields.year) || 0));
  const out = [...rows];
  slots.forEach((slot, i) => (out[slot] = pins[i]));
  return out;
}

export async function listSecrets(place: Place) {
  const rows = await repo.listSecrets(place);
  return ipPinsByYear(
    rows.map((s) => ({
      id: s.id,
      template: s.template,
      label: s.label,
      description: s.description,
      fields: repo.openFields(s.fields),
      hasValue: s.ciphertext !== null,
      movedFromName: s.movedFromName,
      createdByName: nameOf(s.createdBy),
      // who changed it last, which is who the list's "Changed" column names (§15)
      updatedByName: nameOf(s.updatedBy) ?? nameOf(s.createdBy),
      updatedAt: s.updatedAt.toISOString(),
      files: s.files.map(fileRowOf),
    })),
  );
}

export async function createSecret(
  place: Place,
  input: SecretInput,
  actor: User,
  ip: string | null,
) {
  await assertPlace(place);

  // A pointer-only entry (nothing sealed) is a first-class choice, not a mistake: it is how
  // something too sensitive to hold gets recorded without being held.
  const created = await repo.createSecret({
    place,
    template: input.template,
    label: input.label,
    description: input.description ?? null,
    fields: openFieldsOf(input),
    sealed: sealedFrom(input) ?? null,
    createdById: actor.id,
  });
  await repo.writeAudit({
    secretId: created.id,
    clientId: clientOf(place) ?? null,
    byUserId: actor.id,
    action: "created",
    label: input.label,
    ip,
  });
  /**
   * **The mirror, beside the journal it mirrors** (activity-log.md §9).
   *
   * `SecretAuditLog` keeps its IP, its label snapshot and the screens that read it. This says the
   * act happened somewhere findable without knowing which journal to ask — and it carries
   * `clientId`, so the client card's Activity tab finds it even though the SUBJECT is a secret.
   */
  record("secret.created", {
    subjectId: created.id,
    subjectLabel: labelIn(place, input.label),
    clientId: clientOf(place),
  });
  return listSecrets(place);
}

export async function updateSecret(
  place: Place,
  secretId: string,
  input: SecretInput,
  actor: User,
  ip: string | null,
) {
  const secret = await repo.findSecret(place, secretId);
  if (!secret) throw new NotFoundError("Secret not found");
  if (secret.template !== input.template) {
    // A template is fixed once saved (§3.3, decision 11): mapping fields between templates would
    // be guesswork with credentials, so changing one means making a new entry.
    throw new ValidationError(
      "A secret's template cannot be changed. Make a new entry for the other template",
    );
  }

  const storedOpen = repo.openFields(secret.fields);
  const fields = openFieldsOf(input, storedOpen);
  const sealed = sealedFrom(input);

  await repo.updateSecret(place, secretId, {
    label: input.label,
    description: input.description ?? null,
    fields,
    sealed,
    updatedById: actor.id,
  });
  await repo.writeAudit({
    secretId,
    clientId: clientOf(place) ?? null,
    byUserId: actor.id,
    action: "updated",
    label: input.label,
    ip,
  });
  /**
   * **What moved, and never the value that moved.**
   *
   * The journal records `updated` and stops there, so "was the credential rotated, or did somebody
   * fix a typo in the label" — the question asked after a departure — had no answer. `value` says
   * what happened to the secret, never what it is.
   */
  const words =
    diff(
      { label: secret.label, description: secret.description },
      { label: input.label, description: input.description ?? null },
      ["label", "description"],
    ) ?? {};
  // My secrets are logged by the act and never by their words (§3.2, §11): that the title changed,
  // not what it said before or after (audit, 2026-09-16)
  const changed: Record<string, unknown> =
    place.space === "personal"
      ? Object.fromEntries(Object.keys(words).map((key) => [key, "changed"]))
      : words;
  const movedOpen = [...new Set([...Object.keys(storedOpen), ...Object.keys(fields)])].filter(
    (key) => (storedOpen[key] ?? "") !== (fields[key] ?? ""),
  );
  if (movedOpen.length) changed.openFields = movedOpen.join(", ");
  if (sealed !== undefined) {
    if (input.template === "free_form") {
      changed.value = {
        from: secret.ciphertext ? "stored" : "none",
        to: sealed ? "stored" : "none",
      };
    } else {
      // NAMES, never values (§11): "password, PIN" is what a reader needs, and all they may have
      const names = changedSecretNames(secret, input);
      changed.secretFields = names.length ? names.join(", ") : sealed ? "stored" : "none";
    }
  }
  record("secret.updated", {
    subjectId: secretId,
    subjectLabel: labelIn(place, input.label),
    clientId: clientOf(place),
    changes: changed,
  });
  return listSecrets(place);
}

/**
 * **Deleting moves the secret to the Trash** (decision 4, 2026-09-15), which reverses "delete needs
 * the password" (user, 2026-08-03). That password was there because the delete was final; it is not
 * any more, and a mistake is undone rather than paid for. The journal keeps the act either way.
 */
export async function deleteSecret(
  place: Place,
  secretId: string,
  actor: User,
  ip: string | null,
) {
  const secret = await repo.findSecret(place, secretId);
  if (!secret) throw new NotFoundError("Secret not found");
  // the audit row is written FIRST and keeps `secretId` — a secret in the Trash, and later a purged
  // one, must not erase the record that it existed and who looked at it
  await repo.writeAudit({
    secretId,
    clientId: clientOf(place) ?? null,
    byUserId: actor.id,
    action: "deleted",
    label: secret.label,
    ip,
  });
  const batchId = randomUUID();
  await repo.trashSecret(place, secretId, actor.id, batchId);
  record("secret.deleted", {
    subjectId: secretId,
    subjectLabel: labelIn(place, secret.label),
    clientId: clientOf(place),
  });
  // the gesture's id goes back with the list, so the screen can offer Undo on it (§9)
  return { items: await listSecrets(place), batchId };
}

/**
 * **Several secrets into the Trash as one gesture** (§9). A selection stays within one place, and
 * they share a batch id, so the Trash lists them together and one Undo brings them all back.
 */
export async function deleteSecrets(
  place: Place,
  input: DeleteSecretsInput,
  actor: User,
  ip: string | null,
) {
  const rows = await repo.findInPlace(place, input.ids);
  if (rows.length !== input.ids.length) {
    throw new NotFoundError("Some of those secrets are not there any more");
  }
  const batchId = randomUUID();
  // the journal first, as for one: the act is on record before anything moves
  await repo.writeAudits(
    rows.map((row) => ({
      secretId: row.id,
      clientId: clientOf(place) ?? null,
      byUserId: actor.id,
      action: "deleted" as const,
      label: row.label,
      ip,
    })),
  );
  await repo.trashMany(
    place,
    rows.map((row) => row.id),
    actor.id,
    batchId,
  );
  for (const row of rows) {
    record("secret.deleted", {
      subjectId: row.id,
      subjectLabel: labelIn(place, row.label),
      clientId: clientOf(place),
    });
  }
  return { deleted: rows.length, batchId };
}

/** A place in the words a person reads in the log (§7, §11). */
async function placeWords(place: Place): Promise<string> {
  if (place.space === "personal") return "My secrets";
  if (place.space === "company") return "Company";
  const name = await repo.clientLabel(place.clientId);
  return name ? `Clients › ${name}` : "a client";
}

const samePlace = (a: Place, b: Place) =>
  a.space === b.space &&
  (a.space !== "client" || a.clientId === (b as { clientId: string }).clientId) &&
  (a.space !== "personal" || a.ownerId === (b as { ownerId: string }).ownerId);

/**
 * **Moving a secret** (§7). From My secrets or Company anyone with Secrets may move; OUT of a
 * client only an admin may, through the route of its own that says so, and that move is kept long
 * because it is the one that changes who a credential belongs to.
 *
 * A selection stays within one place, so the source is a place and the rows are looked for in it:
 * a secret named from anywhere else is simply not found. The ciphertext is not touched, since the
 * key is the same everywhere.
 */
export async function moveSecrets(
  from: Place,
  input: MoveSecretsInput,
  actor: User,
  ip: string | null,
) {
  const to: Place =
    input.to.space === "personal"
      ? myPlace(actor)
      : input.to.space === "company"
        ? companyPlace()
        : await clientPlace(actor, input.to.clientId, "write");
  await assertPlace(to);
  if (samePlace(from, to)) throw new ValidationError("They are already there");

  const rows = await repo.findInPlace(from, input.ids);
  if (rows.length !== input.ids.length) {
    throw new NotFoundError("Some of those secrets are not there any more");
  }

  const [fromWords, toWords] = await Promise.all([placeWords(from), placeWords(to)]);
  // the badge a leaver's move left belongs to Company, and goes when the secret does (§8)
  await repo.applyMove(
    rows.map((row) => row.id),
    from,
    to,
  );

  await repo.writeAudits(
    rows.map((row) => ({
      secretId: row.id,
      clientId: clientOf(to) ?? clientOf(from) ?? null,
      byUserId: actor.id,
      action: "moved" as const,
      label: row.label,
      ip,
    })),
  );
  for (const row of rows) {
    // a move across places is logged with the title under its non-personal end (§11)
    record(from.space === "client" ? "secret.refiled" : "secret.moved", {
      subjectId: row.id,
      subjectLabel: row.label,
      clientId: clientOf(to) ?? clientOf(from),
      changes: { from: fromWords, to: toWords },
    });
  }
  return { moved: rows.length, to: toWords };
}

/**
 * Re-authenticate with the caller's OWN login password and open a five-minute window on the whole
 * vault. A wrong password is journalled too — that log is the only way a guessing run is visible.
 */
export async function unlock(
  sessionId: string | null,
  input: UnlockVaultInput,
  actor: User,
  ip: string | null,
) {
  const ok = actor.passwordHash
    ? await argon2.verify(actor.passwordHash, input.password)
    : false;
  if (!ok) {
    await repo.writeAudit({
      secretId: null,
      clientId: null, // an unlock opens the vault, not one client (§11)
      byUserId: actor.id,
      action: "unlock_failed",
      label: null,
      ip,
    });
    record("secret.unlock_failed", {});
    // Names WHICH password, because that is the part people get wrong. Somebody who assumes the
    // vault has a password of its own will try one that never existed and read "Wrong password" as
    // a fault in the app (user, 2026-09-04).
    throw new ForbiddenError("Wrong password. Use the one you sign in with");
  }
  if (!sessionId) throw new ForbiddenError("Sign in again to unlock the vault");

  // sweep on the way in: an expired entry is otherwise only dropped when that exact session asks
  // again, so the map grew by one per unlock and never shrank
  const now = Date.now();
  for (const [k, until] of grants) if (until <= now) grants.delete(k);

  const expiresAt = now + GRANT_MS;
  grants.set(sessionId, expiresAt);
  /**
   * **The journal records failures and reveals, and never a success** — so "seven failures" could
   * not be told apart from "seven failures and then they got in" (activity-log.md §4.5).
   */
  record("secret.vault_unlocked", {});
  return { expiresAt: new Date(expiresAt).toISOString() };
}

/** How long this session's window has left — drives the countdown, reveals nothing. */
export function grantStatus(sessionId: string | null) {
  const until = activeGrant(sessionId);
  return { expiresAt: until ? new Date(until).toISOString() : null };
}

/** Hand back the plaintext. Requires a live grant, and writes exactly one audit row. */
export async function revealSecret(
  sessionId: string | null,
  place: Place,
  secretId: string,
  actor: User,
  ip: string | null,
) {
  const until = activeGrant(sessionId);
  if (!until) throw new ForbiddenError("Enter your password to see values");

  const secret = await repo.findSecret(place, secretId);
  if (!secret) throw new NotFoundError("Secret not found");
  if (!secret.ciphertext || !secret.iv || !secret.authTag) {
    throw new ValidationError("This entry holds no value. Its description says where it lives");
  }
  assertConfigured();

  // one reveal opens ALL of an entry's secret fields, and counts as one look (§6)
  const fields = unsealSecret({
    template: secret.template,
    ciphertext: secret.ciphertext,
    iv: secret.iv,
    authTag: secret.authTag,
    keyVersion: secret.keyVersion,
  });
  // One row per LOOK, not per click: opening the edit form reveals the value as well, so a couple
  // of clicks left a run of identical entries seconds apart and buried the rest of the log.
  const justLooked = await repo.recentReveal(secretId, actor.id, new Date(Date.now() - 60_000));
  if (!justLooked) {
    await repo.writeAudit({
      secretId,
      clientId: clientOf(place) ?? null,
      byUserId: actor.id,
      action: "revealed",
      label: secret.label,
      ip,
    });
    // inside the same guard, deliberately: the mirror follows the journal's one-row-per-LOOK rule
    // rather than inventing a second, and the two cannot drift because they are the same branch
    record("secret.revealed", {
      subjectId: secretId,
      subjectLabel: labelIn(place, secret.label),
      clientId: clientOf(place),
    });
  }
  return { secret: fields, expiresAt: new Date(until).toISOString() };
}

/** The client's access history — it names who looked at what, and when. */
const AUDIT_PAGE_SIZE = 10;

export async function listAudit(clientId: string, page = 1) {
  const { items, total } = await repo.listAudit(clientId, Math.max(1, page), AUDIT_PAGE_SIZE);
  const rows = items.map((r) => ({
    id: r.id,
    action: r.action,
    // the snapshot first; the live row only as a fallback for pre-2026-08-03 entries
    label: r.label ?? r.secret?.label ?? null,
    byName: `${r.byUser.firstName} ${r.byUser.lastName}`.trim(),
    createdAt: r.createdAt.toISOString(),
  }));
  return { items: rows, total, page: Math.max(1, page), pageSize: AUDIT_PAGE_SIZE };
}

/** Test seam: a fresh process starts with no grants, and so must a fresh test. */
export function __clearGrants() {
  grants.clear();
}
