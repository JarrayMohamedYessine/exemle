/**
 * SuperStudent.TN — Schema Bootstrap Module
 * Ensures analytics and related tables exist idempotently in Turso.
 * Safe for concurrent cold starts; uses in-memory flag on warm invocations.
 */

import { Client } from "@libsql/client/web";
import { getDatabaseClient, DatabaseEnv } from "./client";

let isSchemaEnsured = false;
let ongoingBootstrap: Promise<void> | null = null;

export const ANALYTICS_MIGRATION_ID = "20261027_01_analytics_engine_schema";

export const DDL_STATEMENTS = [
  // 1. Migration tracking table
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`,

  // 2. Core file stats table
  `CREATE TABLE IF NOT EXISTS file_stats (
    file_id TEXT PRIMARY KEY,
    total_views INTEGER NOT NULL DEFAULT 0 CHECK (total_views >= 0),
    total_download_requests INTEGER NOT NULL DEFAULT 0 CHECK (total_download_requests >= 0),
    last_views_sync_at INTEGER,
    last_downloads_sync_at INTEGER,
    updated_at INTEGER NOT NULL
  );`,

  // 3. Indexes for fast leaderboard querying
  `CREATE INDEX IF NOT EXISTS file_stats_total_views_idx 
    ON file_stats(total_views DESC);`,

  `CREATE INDEX IF NOT EXISTS file_stats_total_downloads_idx 
    ON file_stats(total_download_requests DESC);`,

  // 4. Progress watermark for scheduled cron sync
  `CREATE TABLE IF NOT EXISTS stats_sync_state (
    id TEXT PRIMARY KEY,
    watermark_views INTEGER NOT NULL DEFAULT 0,
    watermark_downloads INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_run_status TEXT,
    last_error TEXT
  );`,

  // 5. Seed default global progress marker
  `INSERT OR IGNORE INTO stats_sync_state (
    id, watermark_views, watermark_downloads, last_run_at, last_run_status, last_error
  ) VALUES (
    'global', 0, 0, NULL, 'initialized', NULL
  );`,

  // 6. Optional daily breakdown for sparklines / historical trends
  `CREATE TABLE IF NOT EXISTS file_stats_daily (
    file_id TEXT NOT NULL,
    day_utc TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
    download_requests INTEGER NOT NULL DEFAULT 0 CHECK (download_requests >= 0),
    PRIMARY KEY (file_id, day_utc)
  );`,

  `CREATE INDEX IF NOT EXISTS file_stats_daily_file_idx 
    ON file_stats_daily(file_id);`,

  `CREATE INDEX IF NOT EXISTS file_stats_daily_day_idx 
    ON file_stats_daily(day_utc DESC);`,

  // 7. Base documents table for legacy fallback and reference
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subject_id TEXT,
    branch_ids TEXT,
    doc_type TEXT,
    file_url TEXT,
    corrige_url TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS documents_active_idx 
    ON documents(id) WHERE is_deleted = 0;`,

  // 8. Core Users table
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email_normalized TEXT UNIQUE NOT NULL,
    username_normalized TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'teacher', 'moderator', 'admin', 'superadmin')),
    branch TEXT NOT NULL DEFAULT 'math',
    grade_level TEXT NOT NULL DEFAULT '4eme_bac',
    avatar_url TEXT,
    can_upload INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_uq
    ON users(email_normalized);`,

  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_normalized_uq
    ON users(username_normalized);`,

  `CREATE INDEX IF NOT EXISTS users_role_idx
    ON users(role);`,

  // 9. Sessions table
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    user_agent TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS sessions_user_idx
    ON sessions(user_id);`,

  `CREATE INDEX IF NOT EXISTS sessions_expires_idx
    ON sessions(expires_at);`,

  // 10. Daily Registration Atomic Safety Counter (15,000 new registrations cap per day)
  `CREATE TABLE IF NOT EXISTS registration_daily_counter (
    day_utc TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
  );`,

  // 11. System Configuration
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at INTEGER NOT NULL
  );`,

  `INSERT OR IGNORE INTO system_config (key, value, description, updated_at) VALUES 
    ('daily_registration_cap', '15000', 'Maximum successful new registrations allowed per day', 1761552000000),
    ('invite_only_active', 'true', 'Whether invite code is strictly required during rollout week', 1761552000000),
    ('invite_code', 'BAC2025', 'Rollout invitation code for new students', 1761552000000);`,

  // 12. Audit Log Table for High-Impact Actions
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS audit_log_created_idx 
    ON audit_log(created_at DESC);`,

  `CREATE INDEX IF NOT EXISTS audit_log_actor_idx 
    ON audit_log(actor_id);`,

  // 13. Announcements Table
  `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('general', 'tip', 'alert', 'live_class')),
    target_branches TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_published INTEGER NOT NULL DEFAULT 1,
    author_id TEXT NOT NULL,
    file_url TEXT,
    corrige_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS announcements_published_idx 
    ON announcements(is_published, created_at DESC);`,

  // 14. Document Files Table
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    url TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    mime_type TEXT,
    created_at INTEGER NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS files_doc_idx 
    ON files(document_id);`,

  // 15. Student Feedback Table
  `CREATE TABLE IF NOT EXISTS student_feedbacks (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    email TEXT,
    full_name TEXT,
    category TEXT,
    message TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );`,

  // 16. Elite Applications Table
  `CREATE TABLE IF NOT EXISTS elite_applications (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    applicant_role TEXT NOT NULL DEFAULT 'student',
    specialty TEXT,
    discord_username TEXT,
    branch TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    proof_url TEXT,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    created_at INTEGER NOT NULL
  );`,

  // 17. Dynamic FAQs Table
  `CREATE TABLE IF NOT EXISTS dynamic_faqs (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'عام',
    author_email TEXT,
    author_role TEXT,
    created_at INTEGER NOT NULL
  );`,

  // 18. Complaint Reports Table
  `CREATE TABLE IF NOT EXISTS complaint_reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT,
    reported_username TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );`,

  // 19. Content Versions Table for Cache Invalidation & ETags
  `CREATE TABLE IF NOT EXISTS content_versions (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );`,

  `INSERT OR IGNORE INTO content_versions (id, version, updated_at) VALUES 
    ('documents', 1, 1761552000000),
    ('announcements', 1, 1761552000000);`,

  // 20. Invitations Table
  `CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    code_hash TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );`,

  // 21. Rate Limit Counters Table
  `CREATE TABLE IF NOT EXISTS rate_limit_counters (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    reset_at INTEGER NOT NULL
  );`,
];

export async function ensureAnalyticsSchema(clientOrEnv?: Client | DatabaseEnv): Promise<void> {
  if (isSchemaEnsured) {
    return;
  }

  if (ongoingBootstrap) {
    return ongoingBootstrap;
  }

  const client =
    clientOrEnv && "execute" in clientOrEnv
      ? (clientOrEnv as Client)
      : getDatabaseClient(clientOrEnv as DatabaseEnv);

  ongoingBootstrap = (async () => {
    try {
      // Step 1: Ensure schema_migrations table exists first
      await client.execute(DDL_STATEMENTS[0]);

      // Step 2: Check if migration has already been applied
      const existing = await client.execute({
        sql: "SELECT id FROM schema_migrations WHERE id = ?",
        args: [ANALYTICS_MIGRATION_ID],
      });

      if (existing.rows.length === 0) {
        // Run all DDL statements in order
        for (const sql of DDL_STATEMENTS) {
          await client.execute(sql);
        }

        // Record migration completion inside schema_migrations
        await client.execute({
          sql: "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)",
          args: [ANALYTICS_MIGRATION_ID, Date.now()],
        });
      }

      isSchemaEnsured = true;
    } catch (err) {
      console.error("[Schema Bootstrap] Failed to bootstrap analytics schema:", err);
      throw err;
    } finally {
      ongoingBootstrap = null;
    }
  })();

  return ongoingBootstrap;
}

/**
 * Resets the in-memory schema flag (used by unit tests to test cold-start bootstrapping).
 */
export function _resetSchemaEnsuredForTesting(): void {
  isSchemaEnsured = false;
  ongoingBootstrap = null;
}
