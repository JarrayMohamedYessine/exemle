-- ==============================================================================
-- SuperStudent.TN — Core Authentication & System Configuration Schema
-- Database: Turso (libSQL) 'superstudent'
-- All statements are idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- ==============================================================================

-- 1. Canonical Users Table
CREATE TABLE IF NOT EXISTS users (
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
);

-- Fast lookup indexes for login by normalized email or username
CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_uq
  ON users(email_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_normalized_uq
  ON users(username_normalized);

CREATE INDEX IF NOT EXISTS users_role_idx
  ON users(role);

-- 2. User Sessions Table (HttpOnly / Bearer session validation)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON sessions(user_id);

CREATE INDEX IF NOT EXISTS sessions_expires_idx
  ON sessions(expires_at);

-- 3. Daily Registration Atomic Safety Counter (15,000 new registrations cap per day)
-- Enforced atomically on the server; does NOT affect existing user logins
CREATE TABLE IF NOT EXISTS registration_daily_counter (
  day_utc TEXT PRIMARY KEY,  -- Format: 'YYYY-MM-DD'
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);

-- 4. Global System Configuration (e.g. invite-only week 1 gating, invite code)
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at INTEGER NOT NULL
);

-- Seed default initial rollout configuration (1-week invite code required)
INSERT OR IGNORE INTO system_config (key, value, description, updated_at) VALUES 
  ('daily_registration_cap', '15000', 'Maximum successful new registrations allowed per day', 1761552000000),
  ('invite_only_active', 'true', 'Whether invite code is strictly required during rollout week', 1761552000000),
  ('invite_code', 'BAC2025', 'Rollout invitation code for new students', 1761552000000),
  ('invite_only_expires_at', '1762156800000', 'Unix timestamp when invite-only mode expires (1 week)', 1761552000000);
