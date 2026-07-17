# Module scaffold

Copy this folder to `server/modules/<name>/` and rename the `__name__` placeholders.
Fixed shape (architecture contract): `routes → service → repository → Prisma`.

- `index.ts` — the module's ONLY public surface (Fastify plugin). Other modules import
  nothing else from here (enforced by ESLint).
- `__name__.routes.ts` — HTTP layer; Zod schemas from `shared/`; never touches Prisma.
- `__name__.service.ts` — business logic; never touches `request`/`reply`.
- `__name__.repository.ts` — ALL Prisma access for this module.
- `__name__.schema.ts` — module-local DTOs (cross-cutting ones live in `shared/schema/`).

Register in `server/app.ts`:

```ts
await app.register(exampleModule, { prefix: "/api/example" });
```
