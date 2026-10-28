# AGENTS.md — SuperStudent.TN (Base44 sandbox)

## Structure
- `artifacts/superstudent` — the product: React 19 + Vite client (`src/`), and a Cloudflare
  Worker API (`src/worker/index.ts`) that also owns all SQL. `src/` is shared by both.
- `artifacts/mockup-sandbox` — component preview harness, not part of the running app.
- No lockfile is committed; `npm install` resolves from the network (see `install` service).

## Running locally (docker compose)
`docker compose -f docker-compose.base44.yml up -d` brings up four services:
- `db` — local `ghcr.io/tursodatabase/libsql-server` (Turso-compatible). Data persists in the
  `sqld-data` volume. Without this the app silently falls back to an in-memory SQL mock
  (`src/db/client.ts`), which resets on every API restart.
- `install` — one-shot `npm install` at the workspace root; `web` and `api` wait for it.
- `api` — the worker under `wrangler dev` on port 8787. The wrangler config is generated at
  container start in `/tmp/wrangler.dev.json` (no `assets` binding) so the built `dist/` is not
  required; worker vars come from the container environment.
- `web` — Vite dev server on host port 3000. `API_PROXY_TARGET=http://api:8787` makes
  `vite.config.ts` proxy `/api/*` to the worker; unset in production (same origin).

## Quirks
- The frontend calls the API with same-origin relative URLs (`/api/...`), so the dev server must
  proxy `/api` — there is no configurable API base URL.
- Schema is created lazily and idempotently by `src/db/ensureSchema.ts` on first API use
  (`ensureAnalyticsSchema`). `sql/*.sql` are documentation of the same tables; no migration step.
- `TURSO_AUTH_TOKEN` is blank against the local sqld (auth disabled). Turso in production needs one.
- Invite-only registration is on by default; the invite code seeds as `BAC2025`.
- Optional integrations that stay silent when unconfigured: Telegram private PDF backup
  (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`), Cloudflare Analytics Engine
  (`CF_ACCOUNT_ID`/`AE_SQL_API_TOKEN`), and browser-side uploads to catbox.moe/buzzheavier.
- Secrets precedence: `.env.base44-defaults` (committed placeholders) is listed before
  `/run/base44/app.env` in compose, so dashboard values always win.

## Checks
- Typecheck: `docker compose -f docker-compose.base44.yml exec -T install sh -c "cd /app && npm run lint"`
  (or run `npx tsc -p artifacts/superstudent/tsconfig.json --noEmit` inside `web`).
- Tests: `docker compose -f docker-compose.base44.yml exec -T web npx vitest run` — vitest is at the
  workspace root; `src/test/*.test.ts` cover analytics, auth and the worker handler.
- API smoke test: `curl -s http://localhost:3000/api/settings/public` (through the Vite proxy).
