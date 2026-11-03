# Thence — local database setup (B0)

Thence uses **PostgreSQL + Drizzle ORM**. The backend stores metadata only:
no custody, no private keys, no Satora recovery secrets.

## 1. Install PostgreSQL 16+

- macOS: `brew install postgresql@16 && brew services start postgresql@16`
- Ubuntu: `sudo apt install postgresql-16`
- Windows: use the official installer, or Docker:
  `docker run --name thence-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=thence -p 5432:5432 -d postgres:16`

## 2. Create database + role

```sql
CREATE USER thence WITH PASSWORD 'thence-dev-only';
CREATE DATABASE thence OWNER thence;
```

For the simplest local path, the default `postgres` superuser works:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/thence
```

## 3. Configure environment

> S0 rule: `DATABASE_URL` in `.env` must never be production. `npm run dev`,
> `start`, `db:migrate`, `db:push` and `db:studio` verify the target first
> (`npm run db:guard`): localhost, or a database carrying the
> `__thence_test_anchor` marker. The production URL is kept only in
> `~/.thence/production.env` and used only by explicit `--production`
> operator commands.

```bash
cp .env.example .env
# edit DATABASE_URL inside .env — placeholders only, never commit .env
```

## 4. Apply migrations

```bash
npm install
npm run db:migrate
```

`db:migrate` applies the drizzle-kit journal (`src/db/migrations/meta/_journal.json`
+ numbered SQL files) via the official drizzle-orm migrator, which records
applied entries in the `__drizzle_migrations` table — re-running is safe.
This is the single versioned migration strategy; do not add a second runner.

Schema evolution afterwards:

```bash
npm run db:generate   # regenerate from src/db/schema.ts (drizzle-kit)
npm run db:push       # push directly (dev only)
npm run db:studio     # inspect
```

## 5. Verify

```bash
npm run typecheck
npm test
npm run dev  # then GET http://localhost:3000/api/health
```

Expected `/api/health` shape (values vary, keys are stable):

```json
{
  "status": "ok",
  "service": "thence-backend",
  "version": "0.1.0-b0",
  "env": "development",
  "enabledRoutes": [],
  "db": { "reachable": true, "latencyMs": 12 },
  "uptimeSec": 4,
  "latencyMs": 15,
  "timestamp": "2026-..."
}
```

`status` is `degraded` when the database is unreachable or env is invalid.
The endpoint never returns credentials or connection strings.

## Notes

- Monetary amounts are atomic-unit integer strings (`TEXT … CHECK ~ '^[0-9]+$'`) — never floats.
- Provider token addresses come from `THENCE_ROUTE_TOKENS_JSON` (verified per
  environment). Empty = EVM routes stay non-quoteable by design.
- Wallet signature verification is implemented in milestone **B1** (Ed25519,
  official Nimiq prefixed scheme); host end-to-end capture is still pending.
