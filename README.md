# buh_crm

Internal CRM for an accounting firm (~10-person team, single firm — not SaaS). Manages clients,
leads, services, tasks, invoices, meetings, and the team.

**Status:** pre-build. Specs, design, and the dev plan are complete (kept in internal docs,
not in this repository); development proceeds stage by stage — foundation (DB schema, auth)
first, then module by module.

## Stack

- **Backend:** Node 20 · TypeScript · Fastify · Prisma · PostgreSQL 16 · Zod (shared schemas) · cookie sessions + Argon2.
- **Frontend:** React 19 · Vite · Tailwind · shadcn/ui · TanStack Query/Table · dnd-kit · React Hook Form.
- **Infra:** Docker Compose (web + api + db) behind Traefik. Dev email via Mailpit.

## Architecture

Modular monolith: one backend, one frontend, one Postgres. Modules follow a fixed shape
(`routes / service / repository / schema`) behind a Fastify plugin; all DB access goes through
the module's repository; Zod schemas in `shared/` validate the API and type the client.

## Structure

- `server/` — Fastify backend (modules under `server/modules/`, cross-cutting core under `server/core/`).
- `src/` — React frontend (mirrors the backend module list).
- `shared/` — Zod schemas + derived types, imported by both sides.
- `prisma/` — schema + migrations.
- `.env.example` — environment variables (identity: `APP_NAME=buh_crm`).

## Development

```
npm install
npm run dev          # frontend (Vite)
npm run dev:server   # backend (tsx watch)
npm run typecheck
npm run build
```

Dev services (Postgres, Mailpit) run in Docker; the app runs locally with hot reload.

> Internal documentation (module specs, design system, decisions, dev plan) is maintained
> outside this repository.
