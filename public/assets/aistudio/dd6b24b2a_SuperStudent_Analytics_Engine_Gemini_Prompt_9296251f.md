SUPERSTUDENT.TN — ANALYTICS ENGINE IMPLEMENTATION PROMPT (FOR GOOGLE AI STUDIO / GEMINI)
Version prepared: 2026-10-27
Scope: File view/download statistics engine only. This prompt extends, and must be executed consistently with, the master prompt `SuperStudent_Final_Implementation_Prompt.txt` and its project inputs `superstudent0-clean.zip` + `SuperStudent_Engineering_Audit_Report.md`.

============================================================
EXECUTION CONTRACT
============================================================
Read the master implementation prompt, the project archive, and the audit report BEFORE writing any code. This document defines the analytics engine only. Where this document and the master prompt overlap, the master prompt's approved decisions win unless this document explicitly refines an analytics-specific rule. Resolve any remaining conflict in favor of the approved decisions listed below, and report the conflict honestly in the final report.

Use current vendor documentation as of the implementation date (this document was prepared 2026-10-27; re-verify everything below at implementation time because endpoints, limits, and billing may change). Prefer official documentation and changelogs. Cite the source URLs and access dates for every fact that determines an implementation decision in the final report. Never fabricate a limit, endpoint, package version, or pricing claim.

Verified reference points as of 2026-10-27 (re-verify at implementation):
- Workers Analytics Engine get-started: https://developers.cloudflare.com/analytics/analytics-engine/get-started/
- Workers Analytics Engine limits (data point schema limits, retention): https://developers.cloudflare.com/analytics/analytics-engine/limits/
- Workers Analytics Engine SQL API: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
- Workers Analytics Engine sampling: https://developers.cloudflare.com/analytics/analytics-engine/sampling-with-wae/
- Workers Analytics Engine pricing/usage-based billing: https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- Cloudflare Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Turso + Workers integration: https://developers.cloudflare.com/workers/databases/third-party-integrations/turso/

============================================================
APPROVED DECISIONS THAT MUST NOT BE CHANGED SILENTLY
============================================================
1. Reuse the already-created Turso database named `superstudent`. Do not create another database and do not reset it. The database may be empty; the analytics tables must be created idempotently by the application itself (see Section 4).
2. The exact Wrangler binding already decided by the owner is fixed and must be used verbatim:
   { "analytics_engine_datasets": [ { "binding": "abc", "dataset": "SuperStudent" } ] }
   The binding name is `abc` and the dataset name is `SuperStudent`. Do not rename them, do not create additional datasets without an explicit requirement.
3. Measurement source is Cloudflare Workers Analytics Engine (WAE). A view or download request is recorded as an Analytics Engine data point written from inside Worker code that is already executing for that request. There is NO database write on any view, NO new Worker route, and NO extra HTTP request created for counting. A view must never trigger a Turso write.
4. The site displays statistics read from Turso counters (cheap, indexed, cacheable). Visitors never trigger an Analytics Engine SQL query and never cause a live-aggregation request.
5. One scheduled task (Cron Trigger), running every 6 hours, pulls aggregated counts from the Analytics Engine SQL API and updates Turso counters in batches. Not one scheduled task per file, not one query per file.
6. A statistics record is created for each file at publication time (when the file is published/added to the catalogue) using an idempotent `INSERT ... ON CONFLICT DO NOTHING`, with a fallback mechanism for pre-existing/legacy files (Section 6).
7. The sync must never double-count: a durable progress point (watermark) is stored in Turso, and the watermark update and the counter updates commit in the SAME database transaction so a crash or rerun is idempotent (Section 7).
8. Counters are labeled accurately: `total_views` counts recorded view events and `total_download_requests` counts recorded download-request events. Never present "download requests" as "completed downloads" unless transfer completion is actually measured. The UI strings in Arabic/French/English must reflect this (e.g., "طلب تحميل" / "download requests" rather than "تحميلات مكتملة").
9. Cloudflare Analytics Engine retains data for three months (90 days). Turso counters are the only long-term storage. Design accordingly (Section 9) and re-verify the retention period at implementation time.
10. Preserve the existing UI, translations, and RTL behavior. Statistics must appear inside the existing design system; do not build a separate dashboard look.
11. Cost target: the 100,000 requests/day Workers allowance must not be consumed by analytics. The scheduled job is 4 invocations/day (every 6 hours); data-point writes piggyback on already-necessary Worker invocations and add zero extra requests. Verify current Workers billing semantics at implementation time and report the actual accounting (whether WAE writes and cron invocations count toward request limits on the current plan).

============================================================
1. ROLE AND DELIVERABLES
============================================================
Act as a senior Cloudflare platform engineer + backend engineer + QA reviewer. You are implementing the statistics subsystem of SuperStudent.TN (React 19 + Vite + TypeScript frontend; Cloudflare Workers backend; Turso/libSQL database `superstudent`; pnpm workspace under `artifacts/superstudent`).

You must deliver COMPLETE, production-ready files, not sketches:
1. `sql/analytics_schema.sql` (or the project's established migration location) — idempotent DDL for all analytics tables and indexes (Section 5).
2. A schema bootstrap module (e.g., `src/db/ensureSchema.ts`) that applies migrations idempotently and safely on first use (Section 4).
3. `src/analytics/record.ts` — the single helper that writes Analytics Engine data points (Section 3).
4. Call-site wiring inside the existing document detail / file metadata / download-issuing handlers (Section 3C), with zero new routes.
5. `src/analytics/sync.ts` — the scheduled batch sync (Section 7).
6. The scheduled handler registration in the Worker entrypoint (`scheduled(controller, env, ctx)`) and the exact Wrangler configuration additions (Section 8).
7. Admin statistics read paths (Section 10).
8. Tests (Section 11) and a final report (Section 12).

No TODOs, no pseudo-code, no ellipses in production paths. If a fact cannot be verified in your environment, implement the safest complete version and state the limitation.

============================================================
2. SYSTEM OVERVIEW (THE FIVE STAGES)
============================================================
Stage 1 — First request / publication of a file:
  Identify the file ID. Its Turso statistics record is created at publication time via `INSERT ... ON CONFLICT DO NOTHING`. Legacy files without a record are handled by the fallback in Section 6.

Stage 2 — Collecting views and download requests:
  View and download events are written as Analytics Engine data points from Worker code that is already executing for that request. No Worker is invoked per view for counting purposes, and no Turso write happens per view.

Stage 3 — One scheduled task every 6 hours:
  A single Cron Trigger invocation processes ALL files whose events fall inside the unprocessed time window, in one run, in chunks. Not a separate task per file.

Stage 4 — Turso update:
  The new aggregates are added to the stored counters, and the watermark is advanced in the same transaction, so no period is counted twice after a restart or rerun.

Stage 5 — Display:
  The site reads the stored counters from Turso (with browser/edge caching per the master prompt's cache policy) and displays them to students.

============================================================
3. EVENT INGESTION — WRITING DATA POINTS (CLOUDFLARE ANALYTICS ENGINE)
============================================================
3A. Binding and dataset
Use the owner's exact binding:
  { "analytics_engine_datasets": [ { "binding": "abc", "dataset": "SuperStudent" } ] }
Datasets are created automatically by Cloudflare on first write after the binding is configured; you must NOT attempt to create the dataset manually.

3B. Data point schema — ONE CONSISTENT SCHEMA FOR THE WHOLE DATASET
A dataset is like a table: every data point written to `SuperStudent` must use the same field positions with the same meaning. Use exactly this layout (adapt names only if the codebase demands, keep positions):
  blobs:
    blob1 = file_id            (the stable internal document/file ID, string)
    blob2 = event_type         ("view" | "download_request"  — fixed lowercase strings)
    blob3 = surface            ("doc_detail" | "download_link" | "announcement_attachment" — where the event happened)
    blob4 = year_month_bucket  (UTC "YYYY-MM" — enables cheap monthly backfill queries; optional but recommended)
  doubles:
    double1 = 1.0              (event counter; enables SUM(_sample_interval * double1))
  indexes:
    index1 = file_id           (sampling key — MUST be the file_id so that per-file aggregation stays accurate under sampling)
Constraints to respect (verified 2026-10-27 against https://developers.cloudflare.com/analytics/analytics-engine/limits/ — re-verify): max 20 blobs, 20 doubles, exactly ONE index per data point; total blob size per data point <= 16 KB; index <= 96 bytes; max 250 data points per Worker invocation. This schema uses 4 blobs, 1 double, 1 index — comfortably inside every limit, and a single Worker invocation serving one page will write at most a handful of points.

3C. Where events are written (and where they MUST NOT be)
- Write a "view" data point inside the EXISTING Worker handler that already serves the document detail / file metadata API response (a Worker request that is happening anyway). `writeDataPoint()` is fire-and-forget (it returns immediately; the runtime writes in the background). It adds no measurable latency and no extra request. Do not await it; do not block the response on it; wrap it in try/catch so an analytics failure NEVER breaks the user-facing response.
- Write a "download_request" data point inside the EXISTING handler that issues/resolves the actual file download link (the endpoint the user hits to obtain the file). This counts a download REQUEST, not a completed transfer.
- Do NOT create any new route, cron, or fetch solely for counting.
- Do NOT write a Turso row, counter update, or any database statement on a view.
- IMPORTANT HONESTY RULE: requests that are answered by the ordinary Cloudflare CDN WITHOUT a Worker invocation cannot be measured by Analytics Engine writes. If (per the master prompt) some public files are served by pure CDN/static delivery with no Worker in the path, those hits are NOT counted by this engine. You must state this clearly in the UI labels/report ("recorded views" rather than implying absolute traffic) and, optionally, document how Cloudflare zone analytics (GraphQL) could be consulted later as a secondary, coarser source. Do not fake coverage.
- PRIVACY: never put IP addresses, emails, usernames, session IDs, or any personal data in blobs/indexes. file_id + event type + surface only. Verify this in tests.

3D. Sampling
Review https://developers.cloudflare.com/analytics/analytics-engine/sampling-with-wae/ and the current dashboard/config options at implementation time. If a per-dataset sampling rate is configurable, document how to keep it at 1.0 (no sampling) while file counts matter, and quantify the cost implications. The queries in Section 7 are written sampling-aware (`_sample_interval`) so they remain correct even if sampling activates under load: a sampled dataset scales each row by `_sample_interval` to approximate the true count. If sampling is active, totals become approximations — the report must state which mode is configured.

============================================================
4. TABLES MUST BE CREATED AUTOMATICALLY (EMPTY TURSO DATABASE)
============================================================
The Turso database `superstudent` is currently empty. The application must build every table it needs automatically, safely, and idempotently:
1. Ship all analytics DDL as `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements in code (a migrations module), not as a manual step the owner must remember.
2. On Worker startup / first use, run a lightweight schema bootstrap:
   - Maintain a `schema_migrations` table (id: text primary key, applied_at) tracking applied migration IDs.
   - Apply each migration at most once, guarded by a transaction; on Worker cold-start concurrency, make application race-safe (e.g., `INSERT OR IGNORE` the migration row inside the same transaction as the DDL, or use a busy-timeout/retry).
   - Keep the bootstrap cheap: on warm invocations, check nothing or a cached flag; do not re-run DDL on every request.
3. Coordinate with the master prompt's broader migration system if one exists in the codebase after you inspect it: analytics tables must be part of the SAME migration mechanism, not a competing second one.
4. Never drop or alter existing tables destructively. Migrations are additive and idempotent.

============================================================
5. TURSO SCHEMA FOR STATISTICS
============================================================
Create (names may be adapted to the project's established naming conventions after inspecting the codebase):

  file_stats: one row per file
    file_id               TEXT PRIMARY KEY,        -- matches documents/files table ID
    total_views           INTEGER NOT NULL DEFAULT 0 CHECK (total_views >= 0),
    total_download_requests INTEGER NOT NULL DEFAULT 0 CHECK (total_download_requests >= 0),
    last_views_sync_at    INTEGER (unix ms, watermark used for views),
    last_downloads_sync_at INTEGER (unix ms, watermark used for downloads),
    updated_at            INTEGER NOT NULL
    -- index if the admin UI lists "most viewed": CREATE INDEX IF NOT EXISTS
    --   file_stats_total_views_idx ON file_stats(total_views DESC);

  stats_sync_state: single-row durable watermark for the scheduled job
    id                     TEXT PRIMARY KEY,        -- constant, e.g. 'global'
    watermark_views        INTEGER NOT NULL,        -- end (exclusive) of last successfully processed window
    watermark_downloads    INTEGER NOT NULL,
    last_run_at            INTEGER,
    last_run_status        TEXT,                    -- 'ok' | 'partial' | 'error'
    last_error            TEXT                      -- short, non-sensitive error summary

  OPTIONAL file_stats_daily (only if the product wants per-day charts; the owner asked whether this is worth it — implement it but keep it cheap):
    file_id TEXT, day_utc TEXT (YYYY-MM-DD), views INTEGER DEFAULT 0, download_requests INTEGER DEFAULT 0,
    PRIMARY KEY (file_id, day_utc)

Notes:
- The scheduled job computes daily rows from the same aggregation query, in the same chunk, with an upsert (`ON CONFLICT ... DO UPDATE SET views = views + excluded...`). Daily rows are derived data and may be rebuilt from the AE window; they must never become the source for totals.
- Timestamps are stored as UTC unix milliseconds; convert to Africa/Tunis timezone only at display time.
- The statistics table is SEPARATE from the documents/files content table, as the owner decided. Never join stats into the main catalogue query unless an index-verified plan proves it cheap.

============================================================
6. RECORD CREATION — PUBLICATION + LEGACY FALLBACK
============================================================
A. Publication path (primary): when a document/file is published or becomes visible in the catalogue, execute in the SAME database transaction that publishes the document:
     INSERT INTO file_stats (file_id, total_views, total_download_requests, updated_at)
     VALUES (?, 0, 0, ?) ON CONFLICT(file_id) DO NOTHING;
   This is the architectural warning the owner raised: creating the stats row on the view path would require a Turso write per view — forbidden. Publication-time creation + the fallback below keeps every view read-only.
B. Legacy/pre-existing files (fallback): the scheduled sync, when it encounters a file_id in the aggregation results that has no file_stats row, must:
     INSERT INTO file_stats (...) VALUES (...) ON CONFLICT(file_id) DO NOTHING;
   but ONLY if the file still exists and is currently visible in the documents/files table (verify with an indexed lookup; a deleted file's events must NOT resurrect a stats row — see Section 8C).
C. Any file published AFTER a sync run started simply enters the next batch (its events fall after the watermark). The sync must not attempt to hold an exhaustive list of files; it processes whatever the time-window aggregation returns.
D. On document deletion, cascade: delete (or soft-mark, consistent with the project's deletion policy) the file_stats and file_stats_daily rows for that file in the same transaction that deletes the document, so the "deleted post" cleanup covers statistics too. Analytics Engine data points themselves are immutable and cannot be deleted; they simply expire after the retention period. State this limitation in the report.

============================================================
7. THE SCHEDULED BATCH SYNC (EVERY 6 HOURS)
============================================================
7A. Trigger
Wrangler config: cron `"0 */6 * * *"` (every 6 hours at minute 0) via `[triggers] crons`. Implement `scheduled(controller, env, ctx)` in the Worker entrypoint, delegating to `src/analytics/sync.ts`. Report whether cron invocations count toward the Workers request allowance on the current plan, and note that 4 runs/day is negligible against 100,000/day either way. Local test with `wrangler dev --test-scheduled` and the `/__scheduled` endpoint.

7B. Query (one aggregated pull, not one query per file)
Call the Analytics Engine SQL API (verified 2026-10-27 — re-verify):
  POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql
  Authorization: Bearer <AE_SQL_API_TOKEN>   (API token with Account Analytics Read)
  Content-Type: text/plain; body = the SQL text
Query (sampling-aware, window-bounded, GROUP BY file):
  SELECT
    blob1  AS file_id,
    blob2  AS event_type,
    SUM(_sample_interval * double1) AS cnt,
    MIN(timestamp) AS window_min_ts,
    MAX(timestamp) AS window_max_ts
  FROM SuperStudent
  WHERE timestamp > toDateTime64({watermark_unix_seconds}, 3, 'UTC')
    AND timestamp <= toDateTime64({window_end_unix_seconds}, 3, 'UTC')
    AND blob2 IN ('view','download_request')
  GROUP BY file_id, event_type
  ORDER BY file_id
  LIMIT 1000;
Adjust exact timestamp literal syntax to the CURRENT Analytics Engine SQL reference at implementation time (verify the literal/date functions the SQL reference supports: https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/). Requirements:
- The window end must be a stable computed instant captured BEFORE the query runs (e.g., `sync_started_at`), never "now" evaluated at different moments.
- The watermark is the exclusive lower bound of the last committed window, so windows tile without gaps or overlaps.
- Paginate results (loop with the same watermark/window-end and `AND blob1 > '{last_file_id}'` while the previous batch returned exactly LIMIT rows) so 100,000+ files cannot overflow one response or memory.
- Handle API errors (401/403/429/5xx) with bounded retries, backoff, and `Retry-After` respect; on persistent failure, write `last_run_status='error'` and exit WITHOUT advancing the watermark (the next run will re-cover the window — idempotent by design).
- Response parsing: expect Cloudflare's documented JSON shape (`meta`/`data`/`rows`); verify against current docs; tolerate the documented `format` parameter if present.

7C. Turso update — idempotent transaction per chunk
Process the aggregated rows in chunks (e.g., 500 files per transaction) using libSQL `batch` (https://turso.tech docs / @libsql/client — verify current API at implementation time):
For each chunk, ONE transaction containing:
  1. For every file_id in the chunk that has no file_stats row AND still exists in documents: `INSERT ... ON CONFLICT(file_id) DO NOTHING` (legacy fallback).
  2. For every file in the chunk:
       UPDATE file_stats
       SET total_views = total_views + ?,            -- for event_type='view'
           last_views_sync_at = ?,
           updated_at = ?
       WHERE file_id = ?;
     (separate UPDATE for download_requests / last_downloads_sync_at, or one UPDATE with CASE — choose what produces the fewest row writes and verify the plan)
  3. Daily rows (if enabled): upsert into file_stats_daily with `views = views + excluded.views`.
  4. Watermark update:
       UPDATE stats_sync_state
       SET watermark_views = ?, watermark_downloads = ?,
           last_run_at = ?, last_run_status = ?
       WHERE id = 'global';
CRITICAL: the counter UPDATEs and the watermark UPDATE commit in the SAME transaction. If the process dies before commit, nothing is applied and the next run re-queries the SAME window — no double count, no lost events. This is the non-negotiable idempotency rule the owner set. Do not use RAM/worker memory to store events or watermarks.

7D. Operational safety
- Total run cost: 1 AE SQL API call per page of results + a bounded number of Turso batch transactions per run (e.g., a few dozen for tens of thousands of files). Record measured numbers in the report.
- Cap the run duration (e.g., stop cleanly before the Worker CPU/duration limits; verify current limits on the deployed plan) and record `last_run_status='partial'` with the remaining window; the next run resumes from the committed watermark.
- All secrets (account ID, AE API token, Turso URL/token) come from Wrangler vars/secrets; never hardcode them, never log their values.
- Write a concise log line per run (counts of files updated, rows, window bounds, status). No personal data in logs.

============================================================
8. WRANGLER / DEPLOYMENT CONFIGURATION (EXACT ADDITIONS)
============================================================
Merge into the existing Wrangler config (JSON form shown; convert to TOML form if the project uses TOML):
{
  "analytics_engine_datasets": [ { "binding": "abc", "dataset": "SuperStudent" } ],
  "triggers": { "crons": [ "0 */6 * * *" ] },
  "vars": { "CF_ACCOUNT_ID": "<owner sets>", "TURSO_DATABASE_URL": "<owner sets>" },
  ... existing config unchanged ...
}
Secrets (never in the file): `AE_SQL_API_TOKEN` (Cloudflare API token, Account Analytics Read), `TURSO_AUTH_TOKEN`.
Deliver a short owner setup checklist: where to create the API token, where to set each secret, and the exact `wrangler deploy` / dashboard steps. Names only — never secret values.

============================================================
9. RETENTION AND RECONCILIATION (3-MONTH AE WINDOW)
============================================================
- Turso counters are the long-term source of truth for totals. AE raw events expire after ~3 months (verify at implementation). Therefore:
  - The watermark must never lag more than ~30 days behind (add an alert/log if `now - watermark > 48h` — likely a broken cron).
  - If the sync is disabled for longer than the AE retention, that period's events are unrecoverable. Document this risk and the mitigation (keep the cron enabled; counters simply stop growing for the missed window — totals already accumulated stay intact).
- Optional (report as a recommendation, implement only if trivial): a one-time backfill mode for existing historical files, bounded to the retained AE window.

============================================================
10. ADMIN STATISTICS ("GHRFAT AL'ADARA" / ADMIN ROOM)
============================================================
The admin area (existing `AdminScreen.tsx`) must show statistics WITHOUT per-request live aggregation:
1. Public/student-facing counters: read from `file_stats` in the existing document detail flow (one indexed lookup, columns only needed: total_views, total_download_requests). Respect the master prompt's browser/edge cache policy for public metadata.
2. Admin dashboards: read precomputed values from Turso (top viewed files, totals) using the index in Section 5, cursor-paginated and bounded. The scheduled job may optionally maintain a small precomputed summary row (e.g., site_totals) as part of its transaction if the admin home needs one-screen numbers without scanning.
3. Live drill-down for the owner (optional, clearly labeled): an admin-only endpoint that proxies a bounded AE SQL query for a chosen file and window. It must be permission-checked server-side, rate-limited, and must use the server-held API token only. Do not build this into the public path.
4. Enforce the role matrix from the master prompt: students see counters only where the current UI intends; no admin data reaches non-admin sessions. All stats API responses that are user-agnostic public counters can be cached per the master prompt; admin stats responses are `no-store`.

============================================================
11. REQUIRED TESTS AND ACCEPTANCE GATES
============================================================
Implement automated tests (Vitest or the project's established runner) for:
A. Schema bootstrap: runs idempotently (twice → no error, no duplicate rows); concurrent first-requests do not corrupt migrations.
B. Ingestion: a document-detail request writes exactly one well-formed data point (mock the binding); a download-link request writes the download_request point; NO Turso write occurs on view; an exception inside the analytics helper never fails the user response; no PII in blobs/index; data point respects WAE limits (blob count, index count/size).
C. Sync idempotency (the owner's core fear — simulate):
   1. Run sync for window W → totals advance, watermark = end(W).
   2. Run sync again immediately (same watermark) → zero additional rows in AE window → totals unchanged.
   3. Simulate a crash AFTER the AE query but BEFORE the Turso commit → rerun → totals counted exactly once.
   4. A file published after the sync started (event after window end) is untouched this run and fully counted next run.
   5. A legacy file with events but no stats row gets a row created (fallback) IF the document exists; a deleted document's file_id does NOT get a row resurrected.
   6. Sampling-aware math: verify the query uses `_sample_interval`; test with sample interval > 1 if the local mock supports it.
   7. 429/5xx from the SQL API: bounded retry, then failure WITHOUT watermark advance; next run recovers.
D. Deletion cascade: deleting a document removes its file_stats/file_stats_daily rows in the same transaction.
E. Display: counters read from Turso only; caching headers/policy follow the master prompt; Arabic RTL strings for stats use the accurate labels from Approved Decision 8.
F. Cron: config contains exactly the intended schedule; local `--test-scheduled` invocation executes the handler.
Run the project's build, type-check, lint, and tests and report ACTUAL results. Never claim a command passed without running it.

============================================================
12. REQUIRED END-OF-WORK REPORT (ANALYTICS ENGINE)
============================================================
1. Exact files created/changed and why.
2. The final data point schema (field positions and meanings) and why it satisfies all WAE limits (with source links + access dates).
3. The sync algorithm walkthrough: window tiling, watermark proof of no double counting under rerun/crash, pagination bounds, measured query/batch counts for a realistic file count.
4. What "views" and "download requests" mean, what is NOT counted (CDN-served hits without Worker invocation, completed-transfer measurement), and the exact UI wording used in all three languages.
5. Cost accounting: cron invocations/day (4), AE write pricing mode on the current plan (with source), whether writes/cron count toward the 100k/day Workers allowance (verified source), expected Turso row-read/row-write counts per sync run and per view (views must be ZERO database writes).
6. Setup checklist for the owner (token creation, secrets, deploy) — names only.
7. Tests run and actual results; known limitations (AE retention, sampling approximation if enabled, immutable AE events on deletion) and recommended next steps.

FINAL EXECUTION RULE
Treat this document as one contract with the master prompt. Do not stop at a plan: inspect the real codebase, implement complete files, run the tests, and report honestly with sources and dates. Never fabricate a verified fact.
