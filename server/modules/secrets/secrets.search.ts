/**
 * **One box over the whole vault** (secrets.md §10), and one secret's own History (§11).
 *
 * The search reads what is OPEN about a secret: its title, its description, the template's open
 * fields and the client it is filed under. Nothing in `searchText` comes from the ciphertext, and a
 * test looks for a stored password and an EIN and finds neither.
 *
 * The visibility rule sits INSIDE the query rather than filtering the answer, so counts and pages
 * are right: a reader's own My secrets, Company, and the clients they may open, never a trashed
 * secret and never an archived client's.
 *
 * The rule for matching is the library's, from the day the owner asked for it there (files.md §13,
 * `f867e7f`): every word must be found somewhere, in any order, so "Olena Petrenko" and "Petrenko
 * Olena" both work; a code is taken as people type it, `142`, `#142`, `C-142` or `C–142`.
 */
import {
  SECRET_TEMPLATES,
  TEMPLATE_COPY,
  type SecretCrumb,
  SecretHistoryRow,
  SecretHit,
  SecretSearchPage,
  type SecretSearchQuery,
} from "@shared/schema/secrets.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { clientText, clientWord, codeOf, wordsOf } from "../../core/client-search.js";
import { NotFoundError } from "../../core/errors.js";
import { opens, readerOf } from "../files/index.js";
import * as repo from "./secrets.repository.js";

const HITS = 50;
const CLIENTS = 10;

/**
 * **A secret with every word somewhere OPEN about it**: its own searchable words, or the name of
 * the client it is filed under. The client half of the rule is `core/client-search.ts`, shared with
 * the library so the two screens answer a name the same way (§10, §20.4).
 *
 * `searchText` is stored lower-cased, so a word is lower-cased to meet it; a client's columns are
 * compared case-insensitively by the shared rule itself.
 */
function secretText(q: string): Prisma.SecretWhereInput {
  const code = codeOf(q);
  const perWord = wordsOf(q).map((word): Prisma.SecretWhereInput => {
    // "bank" or "login" finds the template by its name, as a person calls the kind of secret
    const kinds = SECRET_TEMPLATES.filter((t) =>
      TEMPLATE_COPY[t].label.toLowerCase().includes(word.toLowerCase()),
    );
    return {
      OR: [
        { searchText: { contains: word.toLowerCase() } },
        { client: { is: clientWord(word) } },
        ...(kinds.length ? [{ template: { in: kinds } }] : []),
      ],
    };
  });
  return { OR: [{ AND: perWord }, ...(code ? [{ client: { is: { code } } }] : [])] };
}

/**
 * **The places this reader may see** (§4.3), the one statement of that rule for every read that
 * spans places: the search, a secret's History and the Trash. Their own My secrets, Company, and
 * the clients they may open, never an archived one. A single place is asked by `clientPlace`, which
 * applies the same two conditions to the one client it names.
 */
export async function placesSeenBy(user: User): Promise<Prisma.SecretWhereInput[]> {
  const reader = await readerOf(user);
  const places: Prisma.SecretWhereInput[] = [
    { space: "personal", ownerId: user.id },
    { space: "company" },
  ];
  if (opens(reader, "clients")) {
    places.push({ space: "client", client: { is: { archivedAt: null } } });
  }
  return places;
}

/** Everything this reader may see, as a `where`. The Trash is never in it. */
export async function visibleTo(user: User): Promise<Prisma.SecretWhereInput> {
  return { deletedAt: null, OR: await placesSeenBy(user) };
}

function crumbsOf(
  row: { space: string; clientId: string | null },
  clients: Map<string, string>,
): SecretCrumb[] {
  if (row.space === "personal") return [{ label: "My secrets", to: { type: "my" } }];
  if (row.space === "company") return [{ label: "Company", to: { type: "company" } }];
  const clientId = row.clientId ?? "";
  return [
    { label: "Clients", to: { type: "clients" } },
    { label: clients.get(clientId) ?? "a client", to: { type: "client", clientId } },
  ];
}

export async function search(user: User, query: SecretSearchQuery): Promise<SecretSearchPage> {
  const q = query.q.trim();
  if (!q) return { hits: [], clients: [] };

  const seen = await visibleTo(user);
  const narrowed: Prisma.SecretWhereInput[] = [seen, secretText(q)];
  if (query.template) narrowed.push({ template: query.template });
  if (query.place === "my") narrowed.push({ space: "personal" });
  if (query.place === "company") narrowed.push({ space: "company" });
  if (query.place === "clients") narrowed.push({ space: "client" });

  const rows = await repo.searchSecrets({ AND: narrowed }, HITS);

  /**
   * **Clients show above the secrets** (§10), which is the way to a client that holds none yet.
   * Only with Clients open, never an archived one, and not when the search is narrowed to a
   * template or to a place that is not a client's.
   */
  const reader = await readerOf(user);
  const wantsClients =
    opens(reader, "clients") && !query.template && (!query.place || query.place === "clients");
  const found = wantsClients ? await repo.searchClients(clientText(q), CLIENTS) : [];
  const counts =
    found.length > 0 ? await repo.countByClient(found.map((c) => c.id)) : new Map();

  const names = await repo.clientLabels([
    ...new Set([
      ...rows.flatMap((r) => (r.clientId ? [r.clientId] : [])),
      ...found.map((c) => c.id),
    ]),
  ]);

  const hits: SecretHit[] = rows.map((row) => {
    const crumbs = crumbsOf(row, names);
    return {
      id: row.id,
      template: row.template,
      label: row.label,
      description: row.description,
      fields: repo.openFields(row.fields),
      hasValue: row.ciphertext !== null,
      updatedAt: row.updatedAt.toISOString(),
      path: crumbs.map((c) => c.label).join(" › "),
      crumbs,
    };
  });

  return {
    hits,
    clients: found.map((c) => ({
      id: c.id,
      label: names.get(c.id) ?? "a client",
      code: c.code,
      secrets: counts.get(c.id) ?? 0,
    })),
  };
}

/**
 * **One secret's own journal** (§11): who stored it, who looked at it, who changed which field, and
 * when. Shown to whoever may see the secret, which is the same rule as everything else — a reader
 * who cannot see it gets the answer a stranger gets, that there is nothing here.
 */
export async function history(user: User, secretId: string): Promise<SecretHistoryRow[]> {
  const seen = await visibleTo(user);
  if (!(await repo.findVisible(seen, secretId))) throw new NotFoundError("Secret not found");

  const rows = await repo.historyOf(secretId);
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    byName: `${row.byUser.firstName} ${row.byUser.lastName}`.trim(),
    createdAt: row.createdAt.toISOString(),
  }));
}
