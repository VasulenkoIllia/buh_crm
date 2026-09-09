# Module scaffold

Copy this folder to `server/modules/<name>/` and rename the `__name__` placeholders.
Fixed shape (architecture contract): `routes → service → repository → Prisma`.

- `index.ts` — the module's ONLY public surface (Fastify plugin). Other modules import
  nothing else from here (enforced by ESLint).
- `__name__.routes.ts` — HTTP layer; Zod schemas from `shared/`; never touches Prisma.
- `__name__.service.ts` — business logic; never touches `request`/`reply`.
- `__name__.repository.ts` — ALL Prisma access for this module.
- `__name__.schema.ts` — module-local DTOs (cross-cutting ones live in `shared/schema/`).

## Before you finish: does anything here need a notification?

Ask it once, deliberately, and record the answer — **the build will not let you skip it.**
`shared/notifications.ts` → `MODULE_NOTIFICATIONS` needs an entry for this module: either the
triggers it raises, or the sentence saying why it stays quiet.

The rule that decides it: **a lifecycle event of a record → yes; a step of ordinary work → no.**
Created, assigned, completed, cancelled, overdue, past its due day — those change what somebody
does next. Edited, moved, renamed, ticked — those fire dozens of times a day and *are* the work.

Both answers are fine. What is not fine is leaving it implicit: afterwards, a trigger nobody wanted
and a trigger nobody remembered look exactly the same. Adding a trigger costs one entry in the
registry and one `notify()` call — no migration, because the policy row is seeded on the next boot.

The same question applies to a new FEATURE inside an existing module, where no test can ask it for
you. See `docs/modules/notifications.md` §3.4 for the full reasoning.

## And two more the build also insists on

This file used to ask only the notification question, and it is the only checklist that travels with
the repository — `docs/` and `AGENTS.md` are gitignored, so a fresh clone gets the failing tests
without the prompt that explains them (audit, 2026-09-09).

**1. Every route declares who may call it.** `gate("<unit>")`, `shared()`, `own()` or `anonymous()`
in the route's `config`. A route that declares nothing makes `buildApp()` throw — the server does
not start and every test fails. `shared()` is reference data any signed-in person may read, and it
is open to the whole firm for ever, so **when in doubt it is `gate()`**. Regenerate
`server/route-inventory.json` deliberately and read the diff: that diff is the review.

**2. Every act this module performs is declared as an activity event.** One entry per act in
`shared/activity.ts` (`<subject>.<verb_past>`, with the `changeKeys` the service actually moves,
read off the code rather than guessed), and one `record(...)` call from the SERVICE, after the
repository's transaction has returned. `server/activity.coverage.test.ts` fails if a module with
mutating routes calls `record()` nowhere and is not named as a deliberate exception with a reason;
`server/activity.producers.test.ts` fails if a declared event has no producer. The bare request is
logged either way — what the declaration buys is that the log says *what happened* rather than
*which URL was called*.

Register in `server/app.ts`:

```ts
await app.register(exampleModule, { prefix: "/api/example" });
```
