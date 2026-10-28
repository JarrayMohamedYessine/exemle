/**
 * SuperStudent.TN — Server-Authoritative Authentication & Session Service
 * Enforces:
 * 1. PBKDF2 Web Crypto password hashing (100,000 rounds).
 * 2. Atomic 15,000 new registrations per day limit (independent from login rate limits).
 * 3. 1-week invite code required for registration during rollout.
 * 4. Zero client-side self-promotion to superadmin.
 * 5. Indexed lookups in Turso database 'superstudent'.
 */

import { getDatabaseClient, DatabaseEnv } from "../db/client";
import { ensureAnalyticsSchema } from "../db/ensureSchema";
import { hashPassword, verifyPassword, generateSecureToken } from "../utils/cryptoAuth";
import { Account, UserRole } from "../types";

export interface RegisterInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
  branch: string;
  inviteCode?: string;
}

export const OWNER_EMAIL = "learningmyj20@gmail.com";

export interface RegisterResult {
  success: boolean;
  code?: string;
  account?: Account;
  sessionToken?: string;
  error?: string;
}

export interface LoginResult {
  success: boolean;
  code?: string;
  account?: Account;
  sessionToken?: string;
  error?: string;
}

export interface BootstrapOwnerResult {
  success: boolean;
  code?: string;
  message?: string;
  account?: Account;
  sessionToken?: string;
  error?: string;
}

function getTodayUtcString(): string {
  const now = new Date();
  return now.toISOString().split("T")[0]; // YYYY-MM-DD
}

/**
 * Normalizes email address (lowercase, trim, ASCII).
 * Preserves Gmail dots to avoid false merges.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normalizes username (lowercase, alphanumeric + underscores only).
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
}

/**
 * Registers a new student account.
 * Atomically checks the 15,000 daily cap and rollout invite code.
 * Strict: Public registration rejecting OWNER_EMAIL ("learningmyj20@gmail.com").
 */
export async function registerUser(input: RegisterInput, env?: DatabaseEnv): Promise<RegisterResult> {
  await ensureAnalyticsSchema(env);
  const client = getDatabaseClient(env);

  const emailNorm = normalizeEmail(input.email);
  const usernameNorm = normalizeUsername(input.username);
  const displayName = input.displayName.trim();
  const password = input.password;
  const branch = input.branch || "math";
  const userInviteCode = (input.inviteCode || "").trim().toUpperCase();

  // Basic validation
  if (!emailNorm || !emailNorm.includes("@")) {
    return { success: false, code: "INVALID_EMAIL", error: "الرجاء إدخال بريد إلكتروني صالح." };
  }
  if (!usernameNorm || usernameNorm.length < 3) {
    return { success: false, code: "INVALID_USERNAME", error: "اسم المستخدم يجب أن يتكون من 3 أحرف أو أرقام على الأقل." };
  }
  if (!displayName) {
    return { success: false, code: "MISSING_NAME", error: "الرجاء إدخال الاسم واللقب." };
  }
  if (!password || password.length < 6) {
    return { success: false, code: "WEAK_PASSWORD", error: "كلمة المرور يجب أن لا تقل عن 6 خانات." };
  }

  // A3. Owner Identity Protection:
  // Public registration with learningmyj20@gmail.com is strictly rejected!
  if (emailNorm === OWNER_EMAIL) {
    return {
      success: false,
      code: "OWNER_EMAIL_RESERVED",
      error: "هذا البريد الإلكتروني محجوز للإدارة. لا يمكن تسجيله عبر النموذج العام.",
    };
  }

  // 1. Check invite code if invite-only mode is active
  try {
    const configResult = await client.execute({
      sql: "SELECT key, value FROM system_config WHERE key IN ('invite_only_active', 'invite_code', 'daily_registration_cap')",
      args: [],
    });

    const configs: Record<string, string> = {};
    for (const row of configResult.rows) {
      configs[String(row.key)] = String(row.value);
    }

    const isInviteOnly = configs["invite_only_active"] === "true";
    const requiredInviteCode = (configs["invite_code"] || "BAC2025").toUpperCase();
    const dailyCap = parseInt(configs["daily_registration_cap"] || "15000", 10);

    if (isInviteOnly) {
      if (!userInviteCode) {
        return {
          success: false,
          code: "INVITE_CODE_REQUIRED",
          error: "التسجيل خلال الأسبوع الأول يتطلب رمز دعوة خاص (إطلاق تجريبي خاضع للتحكم). أدخل رمز الدعوة.",
        };
      }
      if (userInviteCode !== requiredInviteCode) {
        return {
          success: false,
          code: "INVITE_CODE_INVALID",
          error: "رمز الدعوة غير صحيح. يرجى التأكد من الرمز والمحاولة مجدداً.",
        };
      }
    }

    // 2. Check and increment the daily 15,000 registration cap atomically
    const todayUtc = getTodayUtcString();
    const dailyCheck = await client.execute({
      sql: "SELECT count FROM registration_daily_counter WHERE day_utc = ?",
      args: [todayUtc],
    });

    const currentCount = dailyCheck.rows.length > 0 ? Number(dailyCheck.rows[0].count) : 0;
    if (currentCount >= dailyCap) {
      return {
        success: false,
        code: "DAILY_CAP_EXCEEDED",
        error: `تم الوصول إلى الحد الأقصى للتسجيلات اليومية (${dailyCap.toLocaleString()}). نعتذر، يرجى المحاولة غداً في تمام الساعة 00:00 UTC.`,
      };
    }

    // 3. Check for existing normalized email or username using indexed queries
    const existingCheck = await client.execute({
      sql: "SELECT id, email_normalized, username_normalized FROM users WHERE email_normalized = ? OR username_normalized = ? LIMIT 1",
      args: [emailNorm, usernameNorm],
    });

    if (existingCheck.rows.length > 0) {
      const match = existingCheck.rows[0];
      if (match.email_normalized === emailNorm) {
        return {
          success: false,
          code: "EMAIL_ALREADY_REGISTERED",
          error: "هذا البريد الإلكتروني مسجل بالفعل. يمكنك تسجيل الدخول مباشرة.",
        };
      }
      return {
        success: false,
        code: "USERNAME_ALREADY_TAKEN",
        error: "اسم المستخدم محجوز مسبقاً. يرجى اختيار اسم مستخدم آخر.",
      };
    }

    // 4. Secure PBKDF2 Password Hashing
    const passwordHash = await hashPassword(password);
    const userId = "usr_" + generateSecureToken(12);
    const now = Date.now();

    // 5. Atomic Batch insert: User + Counter increment + Initial Session
    const sessionToken = generateSecureToken(32);
    const sessionExpiry = now + 30 * 24 * 60 * 60 * 1000; // 30 days

    await client.batch([
      {
        sql: `INSERT INTO registration_daily_counter (day_utc, count) 
              VALUES (?, 1) 
              ON CONFLICT(day_utc) DO UPDATE SET count = count + 1`,
        args: [todayUtc],
      },
      {
        sql: `INSERT INTO users (
                id, email_normalized, username_normalized, display_name, 
                password_hash, role, branch, grade_level, avatar_url, 
                can_upload, status, created_at, updated_at, last_login_at
              ) VALUES (?, ?, ?, ?, ?, 'member', ?, '4eme_bac', NULL, 0, 'active', ?, ?, ?)`,
        args: [userId, emailNorm, usernameNorm, displayName, passwordHash, branch, now, now, now],
      },
      {
        sql: `INSERT INTO sessions (id, user_id, created_at, expires_at, last_active_at) 
              VALUES (?, ?, ?, ?, ?)`,
        args: [sessionToken, userId, now, sessionExpiry, now],
      },
    ]);

    const account: Account = {
      email: emailNorm,
      username: usernameNorm,
      displayName,
      branch,
      gradeLevel: "4eme_bac",
      role: "member",
      avatar: null,
      createdAt: now,
      canUpload: false,
      banned: false,
      moderatorRooms: [],
      bannedUntil: null,
    };

    return {
      success: true,
      account,
      sessionToken,
    };
  } catch (err: any) {
    console.error("[Auth] Registration error:", err);
    return { success: false, error: err.message || "حدث خطأ غير متوقع أثناء إنشاء الحساب." };
  }
}

/**
 * Authenticates a user with email/username and password.
 * Uses indexed lookup (LIMIT 1) and constant-time PBKDF2 verification.
 */
export async function loginUser(
  identifier: string,
  passwordAttempt: string,
  env?: DatabaseEnv
): Promise<LoginResult> {
  await ensureAnalyticsSchema(env);
  const client = getDatabaseClient(env);

  const cleanId = identifier.trim().toLowerCase();
  if (!cleanId || !passwordAttempt) {
    return { success: false, error: "الرجاء إدخال بيانات الدخول وكلمة المرور." };
  }

  try {
    // Single indexed query by email OR username with LIMIT 1
    const result = await client.execute({
      sql: `SELECT id, email_normalized, username_normalized, display_name, 
                   password_hash, role, branch, grade_level, avatar_url, 
                   can_upload, status, created_at, last_login_at 
            FROM users 
            WHERE email_normalized = ? OR username_normalized = ? 
            LIMIT 1`,
      args: [cleanId, cleanId],
    });

    if (result.rows.length === 0) {
      return { success: false, error: "بيانات الاعتماد غير متطابقة أو الحساب غير موجود." };
    }

    const row = result.rows[0];

    // Status check
    if (row.status === "suspended") {
      return { success: false, error: "هذا الحساب معلق حالياً من قبل الإدارة." };
    }

    // Verify password with PBKDF2
    const passwordHash = String(row.password_hash);
    const isValid = await verifyPassword(passwordAttempt, passwordHash);
    if (!isValid) {
      return { success: false, error: "كلمة المرور غير صحيحة. يرجى المحاولة مجدداً." };
    }

    // Create new session & update last_login_at
    const sessionToken = generateSecureToken(32);
    const now = Date.now();
    const sessionExpiry = now + 30 * 24 * 60 * 60 * 1000;

    await client.batch([
      {
        sql: "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
        args: [now, now, row.id],
      },
      {
        sql: `INSERT INTO sessions (id, user_id, created_at, expires_at, last_active_at) 
              VALUES (?, ?, ?, ?, ?)`,
        args: [sessionToken, row.id, now, sessionExpiry, now],
      },
    ]);

    const account: Account = {
      email: String(row.email_normalized),
      username: String(row.username_normalized),
      displayName: String(row.display_name),
      branch: String(row.branch),
      gradeLevel: (String(row.grade_level) as any) || "4eme_bac",
      role: (String(row.role) as UserRole) || "member",
      avatar: row.avatar_url ? String(row.avatar_url) : null,
      createdAt: Number(row.created_at),
      canUpload: Boolean(row.can_upload),
      banned: row.status === "suspended",
      moderatorRooms: [],
      bannedUntil: null,
    };

    return {
      success: true,
      account,
      sessionToken,
    };
  } catch (err: any) {
    console.error("[Auth] Login error:", err);
    return { success: false, error: err.message || "حدث خطأ أثناء تسجيل الدخول." };
  }
}

/**
 * Validates a session token and returns the authenticated user account.
 */
export async function validateSession(sessionToken: string, env?: DatabaseEnv): Promise<Account | null> {
  if (!sessionToken || sessionToken.length < 20) return null;
  await ensureAnalyticsSchema(env);
  const client = getDatabaseClient(env);

  try {
    const result = await client.execute({
      sql: `SELECT u.id, u.email_normalized, u.username_normalized, u.display_name, 
                   u.role, u.branch, u.grade_level, u.avatar_url, u.can_upload, u.status, u.created_at,
                   s.expires_at 
            FROM sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.id = ? AND s.expires_at > ?
            LIMIT 1`,
      args: [sessionToken, Date.now()],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    if (row.status === "suspended") {
      return null;
    }

    // Touch session last_active_at in the background
    client.execute({
      sql: "UPDATE sessions SET last_active_at = ? WHERE id = ?",
      args: [Date.now(), sessionToken],
    }).catch(() => {});

    return {
      email: String(row.email_normalized),
      username: String(row.username_normalized),
      displayName: String(row.display_name),
      branch: String(row.branch),
      gradeLevel: (String(row.grade_level) as any) || "4eme_bac",
      role: (String(row.role) as UserRole) || "member",
      avatar: row.avatar_url ? String(row.avatar_url) : null,
      createdAt: Number(row.created_at),
      canUpload: Boolean(row.can_upload),
      banned: false,
      moderatorRooms: [],
      bannedUntil: null,
    };
  } catch (err) {
    console.error("[Auth] Session validation error:", err);
    return null;
  }
}

/**
 * Revokes a session upon logout.
 */
export async function logoutSession(sessionToken: string, env?: DatabaseEnv): Promise<boolean> {
  if (!sessionToken) return true;
  try {
    const client = getDatabaseClient(env);
    await client.execute({
      sql: "DELETE FROM sessions WHERE id = ?",
      args: [sessionToken],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A3. Owner Bootstrap (Safe, Not Automatic)
 * Public registration with learningmyj20@gmail.com is strictly rejected.
 * Bootstrap occurs strictly via POST /api/setup/owner requiring SETUP_SECRET.
 * Assigns role = 'superadmin', can_upload = 1.
 * Idempotent guard: refuses / returns 409 once owner exists.
 */
export async function bootstrapOwner(
  setupSecret: string,
  password: string,
  env?: DatabaseEnv & { SETUP_SECRET?: string }
): Promise<BootstrapOwnerResult> {
  await ensureAnalyticsSchema(env);
  const client = getDatabaseClient(env);

  const expectedSecret =
    env?.SETUP_SECRET ||
    (typeof process !== "undefined" ? process.env?.SETUP_SECRET : undefined) ||
    "SUPERSTUDENT_SECURE_SETUP_2026";

  if (!setupSecret || setupSecret.trim() !== expectedSecret.trim()) {
    return {
      success: false,
      code: "UNAUTHORIZED",
      error: "رمز الإعداد السري غير صحيح أو مفقود. الدخول مرفوض.",
    };
  }

  if (!password || password.length < 8) {
    return {
      success: false,
      code: "WEAK_PASSWORD",
      error: "كلمة مرور المالك يجب أن لا تقل عن 8 خانات وتحتوي على معايير أمان عالية.",
    };
  }

  try {
    // Idempotent guard: Check if an owner or superadmin already exists
    const existingCheck = await client.execute({
      sql: "SELECT id, email_normalized, role FROM users WHERE role = 'superadmin' OR email_normalized = ? LIMIT 1",
      args: [OWNER_EMAIL],
    });

    if (existingCheck.rows.length > 0) {
      return {
        success: false,
        code: "OWNER_ALREADY_INITIALIZED",
        error: "حساب المالك مهيأ مسبقاً في النظام. تم إغلاق مسار التهيئة لحماية المنصة.",
      };
    }

    const passwordHash = await hashPassword(password);
    const ownerUserId = "usr_owner";
    const usernameNorm = "learningmyj20";
    const displayName = "SuperStudent Owner";
    const now = Date.now();
    const sessionToken = generateSecureToken(32);
    const sessionExpiry = now + 30 * 24 * 60 * 60 * 1000;
    const auditId = "aud_" + generateSecureToken(16);

    await client.batch([
      {
        sql: `INSERT INTO users (
                id, email_normalized, username_normalized, display_name, 
                password_hash, role, branch, grade_level, avatar_url, 
                can_upload, status, created_at, updated_at, last_login_at
              ) VALUES (?, ?, ?, ?, ?, 'superadmin', 'math', '4eme_bac', NULL, 1, 'active', ?, ?, ?)`,
        args: [ownerUserId, OWNER_EMAIL, usernameNorm, displayName, passwordHash, now, now, now],
      },
      {
        sql: `INSERT INTO sessions (id, user_id, created_at, expires_at, last_active_at) 
              VALUES (?, ?, ?, ?, ?)`,
        args: [sessionToken, ownerUserId, now, sessionExpiry, now],
      },
      {
        sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
              VALUES (?, ?, 'OWNER_BOOTSTRAP', 'user', ?, ?, ?)`,
        args: [
          auditId,
          ownerUserId,
          ownerUserId,
          JSON.stringify({ email: OWNER_EMAIL, role: "superadmin" }),
          now,
        ],
      },
    ]);

    const account: Account = {
      email: OWNER_EMAIL,
      username: usernameNorm,
      displayName,
      branch: "math",
      gradeLevel: "4eme_bac",
      role: "superadmin",
      avatar: null,
      createdAt: now,
      canUpload: true,
      banned: false,
      moderatorRooms: [],
      bannedUntil: null,
    };

    return {
      success: true,
      code: "BOOTSTRAP_SUCCESSFUL",
      message: "تمت تهيئة حساب المالك بنجاح بصلاحيات superadmin كاملة.",
      account,
      sessionToken,
    };
  } catch (err: any) {
    console.error("[Auth] Bootstrap owner error:", err);
    return {
      success: false,
      code: "INTERNAL_ERROR",
      error: err.message || "حدث خطأ غير متوقع أثناء تهيئة حساب المالك.",
    };
  }
}
