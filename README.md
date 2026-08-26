# buh_crm

Internal CRM for an accounting firm (~10-person team, single firm — not SaaS). Manages clients and
the companies they hold, leads, a service catalog, tasks with time tracking, invoicing and debt,
meetings, client mailouts, and the team.

**Status:** in use, built stage by stage. Clients, Leads, Catalog, Tasks, Payments, Calendar,
Archive, Client secrets and Mailouts are done; Reports and the production hardening pass are not.
Specs, design and the dev plan are kept in internal docs, not in this repository.

**Modules**

| | |
|---|---|
| **Clients** | a client, the companies they hold, their services (subscription or one-time), files, debt |
| **Leads** | pipeline, and conversion into a client |
| **Catalog** | services, task templates, and the rule that decides when each one bills |
| **Tasks** | board and table, generation on a rhythm, a timer, one-time billable jobs |
| **Payments** | invoices with positions, partial payments, debt, an audited change log |
| **Calendar** | meetings and deadlines on one firm clock |
| **Mailouts** | letter templates, one-off sends, campaigns on a date or a rhythm, unsubscribe, delivery tracking — every mailbox is read back for bounces, so the log says delivered or not rather than merely sent |
| **Secrets** | a client's credentials, encrypted, behind a password prompt and an access log |
| **Archive** | closed work and settled invoices tidied away — never deleted |

## Stack

- **Backend:** Node 20 · TypeScript · Fastify · Prisma · PostgreSQL 16 · Zod (shared schemas) · cookie sessions + Argon2.
- **Frontend:** React 19 · Vite · Tailwind · shadcn/ui · TanStack Query/Table · dnd-kit · React Hook Form.
- **Infra:** Docker Compose — one `app` container serving the API *and* the built SPA, plus `db`,
  behind Traefik. Migrations run on container start. Dev email via Mailpit.

## Architecture

Modular monolith: one backend, one frontend, one Postgres. Modules follow a fixed shape
(`routes / service / repository / schema`) behind a Fastify plugin; all DB access goes through
the module's repository; Zod schemas in `shared/` validate the API and type the client.

## Structure

- `server/` — Fastify backend (modules under `server/modules/`, cross-cutting core under `server/core/`).
- `src/` — React frontend (mirrors the backend module list).
- `shared/` — Zod schemas + derived types, imported by both sides.
- `prisma/` — schema + migrations.
- `scripts/` — server operations (`deploy.sh`, `reset-data.sql`).
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

## Deployment

On the server, from the project directory:

```
./scripts/deploy.sh            # pull, rebuild, verify — data untouched
./scripts/deploy.sh --reset    # …and wipe every client record first, keeping the team
```

Both paths dump the database first and print the restore command at the end. Migrations apply
automatically when the container starts (`prisma migrate deploy && npm run start`), so there is no
separate migration step.

`--reset` asks you to type the database name before it deletes anything, then empties every domain
table and the `data/uploads` directory. Users, their sessions and their reset tokens survive; base
data (priorities, board columns, lead sources, firm profile) is recreated on the next boot, which
means firm settings such as the invoice-number format return to their defaults. It runs BEFORE the
pull on purpose: migrations then land on an empty database instead of migrating rows you are about
to discard.

> Internal documentation (module specs, design system, decisions, dev plan) is maintained
> outside this repository.
