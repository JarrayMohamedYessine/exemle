-- ==============================================================================
-- SuperStudent.TN — Analytics Engine & Turso File Statistics Schema
-- Version: 2026-10-27
-- Database: Turso (libSQL) 'superstudent'
-- All statements are idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- ==============================================================================

-- 1. Schema Migrations Tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- 2. Core File Statistics (one row per published file/document)
-- total_views: recorded view events from Cloudflare Analytics Engine
-- total_download_requests: recorded download request events
CREATE TABLE IF NOT EXISTS file_stats (
  file_id TEXT PRIMARY KEY,
  total_views INTEGER NOT NULL DEFAULT 0 CHECK (total_views >= 0),
  total_download_requests INTEGER NOT NULL DEFAULT 0 CHECK (total_download_requests >= 0),
  last_views_sync_at INTEGER,
  last_downloads_sync_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Fast indexed access for admin leaderboards and ordering
CREATE INDEX IF NOT EXISTS file_stats_total_views_idx 
  ON file_stats(total_views DESC);

CREATE INDEX IF NOT EXISTS file_stats_total_downloads_idx 
  ON file_stats(total_download_requests DESC);

-- 3. Durable Progress Watermark for Scheduled Sync (every 6 hours)
-- Commits in the SAME transaction as counter increments to prevent double-counting
CREATE TABLE IF NOT EXISTS stats_sync_state (
  id TEXT PRIMARY KEY,
  watermark_views INTEGER NOT NULL DEFAULT 0,
  watermark_downloads INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_run_status TEXT,
  last_error TEXT
);

-- Seed global watermark if not present
INSERT OR IGNORE INTO stats_sync_state (
  id, watermark_views, watermark_downloads, last_run_at, last_run_status, last_error
) VALUES (
  'global', 0, 0, NULL, 'initialized', NULL
);

-- 4. Optional Daily Stats for Trend & Sparkline Analysis
CREATE TABLE IF NOT EXISTS file_stats_daily (
  file_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  download_requests INTEGER NOT NULL DEFAULT 0 CHECK (download_requests >= 0),
  PRIMARY KEY (file_id, day_utc)
);

CREATE INDEX IF NOT EXISTS file_stats_daily_file_idx 
  ON file_stats_daily(file_id);

CREATE INDEX IF NOT EXISTS file_stats_daily_day_idx 
  ON file_stats_daily(day_utc DESC);

-- 5. Canonical Documents Table Reference (for legacy fallback verification)
CREATE TABLE IF NOT EXISTS documents (
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
);

CREATE INDEX IF NOT EXISTS documents_active_idx 
  ON documents(id) WHERE is_deleted = 0;
