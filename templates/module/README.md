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
you. See `docs/modules/notifications.md` §3.2 for the full reasoning.

Register in `server/app.ts`:

```ts
await app.register(exampleModule, { prefix: "/api/example" });
```
