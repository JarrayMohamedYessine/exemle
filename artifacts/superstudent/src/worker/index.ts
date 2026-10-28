/**
 * SuperStudent.TN — Cloudflare Worker Entrypoint (2026 Production Architecture)
 * Handles:
 * 1. Scheduled Cron Trigger ('0 *\/6 * * *') -> calls runScheduledSync(env)
 * 2. Document view & download requests -> writes Analytics Engine data points (fire-and-forget, zero Turso writes)
 * 3. Document statistics reads & Admin analytics dashboards
 * 4. Document CRUD, Keyset Pagination, ETag 304 Caching, and 302 Download Redirects (no byte proxying)
 * 5. Announcements CRUD with strict attachment constraints (PDF only on live_class, correction only during edit)
 * 6. Admin user moderation (immediate session revocation on ban/demote, audit logging)
 * 7. Asynchronous Private Telegram PDF Archival Backup (via ctx.waitUntil)
 * 8. Cache-Control policy strictly tailored per data class (600s documents, 180s announcements, 60s settings, private/no-store auth)
 */

import { WorkerEnvWithAnalytics, recordFileView, recordDownloadRequest } from "../analytics/record";
import { runScheduledSync, SyncEnv } from "../analytics/sync";
import { getFileStats, getAdminAnalyticsSummary } from "../analytics/statsService";
import { initFileStats, cascadeDeleteFileStats } from "../analytics/lifecycle";
import { backupPdfToTelegram, TelegramBackupEnv } from "../services/telegramBackup";
import { Account, UserRole } from "../types";

export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface WorkerEnv extends WorkerEnvWithAnalytics, SyncEnv, TelegramBackupEnv {
  ASSETS?: { fetch: typeof fetch };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-setup-secret, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, X-Content-Version",
};

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

async function getAuthUser(request: Request, env: WorkerEnv): Promise<Account | null> {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { validateSession } = await import("../services/serverAuth");
  return await validateSession(token, env);
}

function isAdmin(user: Account | null): user is Account {
  if (!user) return false;
  return user.role === "superadmin" || user.email.toLowerCase() === "learningmyj20@gmail.com";
}

async function getContentVersion(client: any, entityId: "documents" | "announcements"): Promise<number> {
  try {
    const res = await client.execute({
      sql: "SELECT version FROM content_versions WHERE id = ?",
      args: [entityId],
    });
    if (res.rows.length > 0 && res.rows[0].version !== undefined) {
      return Number(res.rows[0].version);
    }
  } catch {}
  return 1;
}

async function bumpContentVersion(client: any, entityId: "documents" | "announcements"): Promise<void> {
  try {
    await client.execute({
      sql: `INSERT INTO content_versions (id, version, updated_at) 
            VALUES (?, 1, ?) 
            ON CONFLICT(id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`,
      args: [entityId, Date.now()],
    });
  } catch (err) {
    console.warn(`[Content Version] Failed to bump version for ${entityId}:`, err);
  }
}

export default {
  /**
   * Scheduled Cron Handler (runs every 6 hours at minute 0)
   */
  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    console.log(`[Worker Cron] Scheduled event triggered at ${new Date(controller.scheduledTime).toISOString()}`);
    ctx.waitUntil(
      runScheduledSync(env).then((res) => {
        console.log(`[Worker Cron] Sync finished with status=${res.status}, processed=${res.filesProcessed}, views=+${res.viewsAdded}, downloads=+${res.downloadsAdded}, duration=${res.durationMs}ms`);
      }).catch((err) => {
        console.error("[Worker Cron] Sync error:", err);
      })
    );
  },

  /**
   * HTTP Fetch Handler
   */
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // ==========================================
    // 0. Auth Endpoints (strictly private, no-store)
    // ==========================================

    if (path === "/api/setup/owner" && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const headerSecret = request.headers.get("x-setup-secret") || "";
        const secret = headerSecret || body.setupSecret || "";
        const password = body.password || "";

        const { bootstrapOwner } = await import("../services/serverAuth");
        const result = await bootstrapOwner(secret, password, env as any);

        let statusCode = 200;
        if (!result.success) {
          if (result.code === "UNAUTHORIZED") statusCode = 401;
          else if (result.code === "OWNER_ALREADY_INITIALIZED") statusCode = 409;
          else statusCode = 400;
        }

        return jsonResponse(result, statusCode, { "Cache-Control": "private, no-store" });
      } catch (err: any) {
        return jsonResponse({ success: false, code: "INTERNAL_ERROR", error: err.message || "Setup failed" }, 500);
      }
    }

    if (path === "/api/auth/register" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { registerUser } = await import("../services/serverAuth");
        const result = await registerUser(body, env);
        return jsonResponse(result, result.success ? 200 : (result.code === "OWNER_EMAIL_RESERVED" ? 403 : 400), {
          "Cache-Control": "private, no-store",
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || "Registration failed" }, 500);
      }
    }

    if (path === "/api/auth/login" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { loginUser } = await import("../services/serverAuth");
        const result = await loginUser(body.identifier, body.password, env);
        return jsonResponse(result, result.success ? 200 : 401, {
          "Cache-Control": "private, no-store",
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message || "Login failed" }, 500);
      }
    }

    if (path === "/api/auth/session" && request.method === "GET") {
      const account = await getAuthUser(request, env);
      return jsonResponse({ success: !!account, account }, account ? 200 : 401, {
        "Cache-Control": "private, no-store",
      });
    }

    if (path === "/api/auth/logout" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      const { logoutSession } = await import("../services/serverAuth");
      await logoutSession(token, env);
      return jsonResponse({ success: true }, 200, { "Cache-Control": "private, no-store" });
    }

    // Profile & Password Update (Private, no-store)
    if (path === "/api/me/profile" && request.method === "PATCH") {
      try {
        const user = await getAuthUser(request, env);
        if (!user) return jsonResponse({ success: false, error: "غير مصرح." }, 401);

        const body = (await request.json()) as any;
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        // Check if changing email
        if (body.email && body.email.toLowerCase() !== user.email.toLowerCase()) {
          const emailNorm = body.email.trim().toLowerCase();
          const existing = await client.execute({
            sql: "SELECT id FROM users WHERE email_normalized = ? AND id != ?",
            args: [emailNorm, user.id || ""],
          });
          if (existing.rows.length > 0) {
            return jsonResponse({ success: false, code: "EMAIL_ALREADY_REGISTERED", error: "البريد الإلكتروني مسجل بالفعل بحساب آخر." }, 409);
          }
          await client.execute({
            sql: "UPDATE users SET email_normalized = ?, updated_at = ? WHERE id = ?",
            args: [emailNorm, Date.now(), user.id || ""],
          });
        }

        if (body.displayName || body.branch || body.gradeLevel || body.avatarUrl !== undefined) {
          await client.execute({
            sql: `UPDATE users 
                  SET display_name = COALESCE(?, display_name),
                      branch = COALESCE(?, branch),
                      grade_level = COALESCE(?, grade_level),
                      avatar_url = COALESCE(?, avatar_url),
                      updated_at = ?
                  WHERE id = ?`,
            args: [body.displayName || null, body.branch || null, body.gradeLevel || null, body.avatarUrl ?? null, Date.now(), user.id || ""],
          });
        }

        return jsonResponse({ success: true, message: "تم تحديث الملف الشخصي بنجاح." }, 200, { "Cache-Control": "private, no-store" });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/me/change-password" && request.method === "POST") {
      try {
        const user = await getAuthUser(request, env);
        if (!user) return jsonResponse({ success: false, error: "غير مصرح." }, 401);

        const body = (await request.json()) as any;
        const currentPassword = body.currentPassword || "";
        const newPassword = body.newPassword || "";

        if (!currentPassword || newPassword.length < 8) {
          return jsonResponse({ success: false, error: "كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل." }, 400);
        }

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const { verifyPassword, hashPassword } = await import("../utils/cryptoAuth");

        const userRow = await client.execute({
          sql: "SELECT password_hash FROM users WHERE id = ?",
          args: [user.id || ""],
        });
        if (userRow.rows.length === 0) return jsonResponse({ success: false, error: "المستخدم غير موجود." }, 404);

        const valid = await verifyPassword(currentPassword, String(userRow.rows[0].password_hash));
        if (!valid) return jsonResponse({ success: false, error: "كلمة المرور الحالية غير صحيحة." }, 400);

        const newHash = await hashPassword(newPassword);
        await client.execute({
          sql: "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
          args: [newHash, Date.now(), user.id || ""],
        });

        // Revoke all other sessions except current
        const currentToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        await client.execute({
          sql: "DELETE FROM sessions WHERE user_id = ? AND id != ?",
          args: [user.id || "", currentToken],
        });

        return jsonResponse({ success: true, message: "تم تغيير كلمة المرور وإلغاء الجلسات الأخرى بنجاح." }, 200, { "Cache-Control": "private, no-store" });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Public Settings endpoint (Edge TTL: 60s, stale-while-revalidate: 30s)
    if (path === "/api/settings/public" && request.method === "GET") {
      try {
        const { getDatabaseClient } = await import("../db/client");
        const { ensureAnalyticsSchema } = await import("../db/ensureSchema");
        await ensureAnalyticsSchema(env);
        const client = getDatabaseClient(env);

        const configRes = await client.execute({
          sql: "SELECT key, value FROM system_config WHERE key IN ('daily_registration_cap', 'invite_only_active')",
          args: [],
        });
        const configs: Record<string, string> = {};
        for (const r of configRes.rows) {
          configs[String(r.key)] = String(r.value);
        }

        const todayUtc = new Date().toISOString().split("T")[0];
        const counterRes = await client.execute({
          sql: "SELECT count FROM registration_daily_counter WHERE day_utc = ?",
          args: [todayUtc],
        });
        const todayCount = counterRes.rows.length > 0 ? Number(counterRes.rows[0].count) : 0;

        return jsonResponse(
          {
            success: true,
            settings: {
              daily_registration_cap: parseInt(configs["daily_registration_cap"] || "15000", 10),
              invite_only_active: configs["invite_only_active"] === "true",
              today_registrations: todayCount,
            },
          },
          200,
          { "Cache-Control": "public, max-age=60, stale-while-revalidate=30" }
        );
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // ==========================================
    // 1. Documents Catalogue & Facets Endpoints
    // (Edge TTL: 600s / 10min per contract 5-15 min, with ETag 304 revalidation)
    // ==========================================

    if (path === "/api/documents/filters" && request.method === "GET") {
      try {
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        const distinctSubjects = await client.execute("SELECT DISTINCT subject_id FROM documents WHERE is_deleted = 0");
        const distinctTypes = await client.execute("SELECT DISTINCT doc_type FROM documents WHERE is_deleted = 0");
        const countRes = await client.execute("SELECT COUNT(*) as count FROM documents WHERE is_deleted = 0");

        return jsonResponse(
          {
            success: true,
            subjects: distinctSubjects.rows.map((r) => String(r.subject_id)),
            docTypes: distinctTypes.rows.map((r) => String(r.doc_type)),
            totalDocuments: Number(countRes.rows[0]?.count || 0),
          },
          200,
          { "Cache-Control": "public, max-age=900, stale-while-revalidate=60" }
        );
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/documents" && request.method === "GET") {
      try {
        const { getDatabaseClient } = await import("../db/client");
        const { ensureAnalyticsSchema } = await import("../db/ensureSchema");
        await ensureAnalyticsSchema(env);
        const client = getDatabaseClient(env);

        const branch = url.searchParams.get("branch") || "";
        const subject = url.searchParams.get("subject") || "";
        const docType = url.searchParams.get("docType") || "";
        const search = url.searchParams.get("q") || "";
        const cursor = url.searchParams.get("cursor"); // created_at cursor for keyset
        const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
        const limit = Math.min(Math.max(1, limitParam), 100);

        // Check content version for ETag invalidation
        const version = await getContentVersion(client, "documents");
        const etag = `W/"docs-v${version}-${cursor || "0"}-${branch}-${subject}-${docType}-${search.slice(0, 8)}"`;

        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              ...CORS_HEADERS,
              "ETag": etag,
              "Cache-Control": "public, max-age=600, stale-while-revalidate=60",
            },
          });
        }

        let whereClauses = ["is_deleted = 0"];
        const args: any[] = [];

        if (subject) {
          whereClauses.push("subject_id = ?");
          args.push(subject);
        }
        if (docType) {
          whereClauses.push("doc_type = ?");
          args.push(docType);
        }
        if (branch) {
          whereClauses.push("branch_ids LIKE ?");
          args.push(`%${branch}%`);
        }
        if (search) {
          whereClauses.push("title LIKE ?");
          args.push(`%${search}%`);
        }
        if (cursor) {
          whereClauses.push("created_at < ?");
          args.push(parseInt(cursor, 10));
        }

        const sql = `SELECT id, title, subject_id, branch_ids, doc_type, file_url, corrige_url, created_at, updated_at 
                     FROM documents 
                     WHERE ${whereClauses.join(" AND ")} 
                     ORDER BY created_at DESC 
                     LIMIT ?`;
        args.push(limit);

        const result = await client.execute({ sql, args });

        const documents = result.rows.map((row) => ({
          id: String(row.id),
          title: String(row.title),
          subjectId: row.subject_id ? String(row.subject_id) : "other",
          branchIds: row.branch_ids ? String(row.branch_ids).split(",") : [],
          docType: row.doc_type ? String(row.doc_type) : "exam",
          fileUrl: row.file_url ? String(row.file_url) : null,
          corrigeUrl: row.corrige_url ? String(row.corrige_url) : null,
          createdAt: Number(row.created_at || Date.now()),
        }));

        const nextCursor = documents.length === limit ? documents[documents.length - 1].createdAt : null;

        return jsonResponse(
          { success: true, documents, nextCursor, count: documents.length },
          200,
          {
            "Cache-Control": "public, max-age=600, stale-while-revalidate=60",
            "ETag": etag,
            "X-Content-Version": String(version),
          }
        );
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Publish new document
    if (path === "/api/documents" && request.method === "POST") {
      try {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ success: false, error: "يجب تسجيل الدخول لنشر الوثائق." }, 401);
        }

        const canUpload = user.canUpload || ["superadmin", "teacher", "elite_student"].includes(user.role);
        if (!canUpload) {
          return jsonResponse({ success: false, error: "ليس لديك صلاحية نشر الوثائق والملخصات." }, 403);
        }

        const body = (await request.json()) as any;
        const title = (body.title || "").trim();
        if (!title) {
          return jsonResponse({ success: false, error: "عنوان الوثيقة مطلوب." }, 400);
        }

        const { getDatabaseClient } = await import("../db/client");
        const { ensureAnalyticsSchema } = await import("../db/ensureSchema");
        await ensureAnalyticsSchema(env);
        const client = getDatabaseClient(env);

        const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        const branchIds = Array.isArray(body.branchIds) ? body.branchIds.join(",") : (body.branchIds || "math");
        const subjectId = body.subjectId || "math";
        const docType = body.docType || "exam";
        const fileUrl = body.fileUrl || body.pdfDataUrl || body.pdfUrl || "";
        const corrigeUrl = body.corrigeUrl || body.corrigePdfDataUrl || body.corrigePdfUrl || null;

        await client.execute({
          sql: `INSERT INTO documents (id, title, subject_id, branch_ids, doc_type, file_url, corrige_url, is_deleted, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          args: [docId, title, subjectId, branchIds, docType, fileUrl, corrigeUrl, now, now],
        });

        // Initialize file_stats row
        await initFileStats(docId, env);

        // Bump content_versions to invalidate old cached document indexes immediately
        await bumpContentVersion(client, "documents");

        // Record in audit log
        await client.execute({
          sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
                VALUES (?, ?, 'PUBLISH_DOCUMENT', 'document', ?, ?, ?)`,
          args: [`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, user.id || user.username || "unknown", docId, JSON.stringify({ title, docType }), now],
        });

        // Asynchronous Telegram Private Backup (via ctx.waitUntil)
        if (fileUrl) {
          ctx.waitUntil(
            backupPdfToTelegram(
              {
                fileUrl,
                fileName: `${title}.pdf`,
                title,
                docId,
                author: user.displayName || user.username,
              },
              env
            ).catch((err) => {
              console.warn("[Telegram Backup] Asynchronous backup error:", err);
            })
          );
        }

        if (corrigeUrl) {
          ctx.waitUntil(
            backupPdfToTelegram(
              {
                fileUrl: corrigeUrl,
                fileName: `${title}_Correction.pdf`,
                title: `${title} (الإصلاح النموذجي)`,
                docId: `${docId}_corrige`,
                author: user.displayName || user.username,
              },
              env
            ).catch((err) => {
              console.warn("[Telegram Backup] Asynchronous backup error for corrige:", err);
            })
          );
        }

        const createdDoc = {
          id: docId,
          title,
          subjectId,
          branchIds: branchIds.split(","),
          docType,
          fileUrl,
          corrigeUrl,
          createdAt: now,
          authorId: user.id,
          authorUsername: user.username,
          authorDisplayName: user.displayName,
        };

        return jsonResponse({ success: true, document: createdDoc }, 201);
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Direct 302 Download Entry Route (Never proxies bytes through Worker)
    if ((path.match(/^\/api\/documents\/([^/]+)\/files\/([^/]+)\/download$/) || path.match(/^\/api\/documents\/([^/]+)\/download$/)) && request.method === "GET") {
      const match = path.match(/^\/api\/documents\/([^/]+)(?:\/files\/([^/]+))?\/download$/);
      const docId = match ? match[1] : "";

      try {
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        const res = await client.execute({
          sql: "SELECT file_url, corrige_url FROM documents WHERE id = ? AND is_deleted = 0",
          args: [docId],
        });

        if (res.rows.length === 0 || !res.rows[0].file_url) {
          return jsonResponse({ success: false, error: "الملف المطلوب غير موجود أو محذوف." }, 404);
        }

        const isCorrige = url.searchParams.get("corrige") === "true";
        const redirectUrl = isCorrige && res.rows[0].corrige_url ? String(res.rows[0].corrige_url) : String(res.rows[0].file_url);

        // Record Analytics Engine download event asynchronously (zero DB writes)
        recordDownloadRequest(env, docId, "download_link");

        // 302 Redirect directly to host provider
        return new Response(null, {
          status: 302,
          headers: {
            "Location": redirectUrl,
            "Cache-Control": "private, no-store",
            ...CORS_HEADERS,
          },
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Get single document detail (Edge TTL: 300s / 5min)
    if (path.match(/^\/api\/documents\/([^/]+)$/) && request.method === "GET") {
      const match = path.match(/^\/api\/documents\/([^/]+)$/);
      const docId = match ? match[1] : "";

      try {
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const res = await client.execute({
          sql: "SELECT id, title, subject_id, branch_ids, doc_type, file_url, corrige_url, created_at FROM documents WHERE id = ? AND is_deleted = 0",
          args: [docId],
        });

        if (res.rows.length === 0) {
          return jsonResponse({ success: false, error: "الوثيقة غير موجودة." }, 404);
        }

        const row = res.rows[0];
        const stats = await getFileStats(docId, env);

        return jsonResponse({
          success: true,
          document: {
            id: String(row.id),
            title: String(row.title),
            subjectId: row.subject_id ? String(row.subject_id) : "other",
            branchIds: row.branch_ids ? String(row.branch_ids).split(",") : [],
            docType: row.doc_type ? String(row.doc_type) : "exam",
            fileUrl: row.file_url ? String(row.file_url) : null,
            corrigeUrl: row.corrige_url ? String(row.corrige_url) : null,
            createdAt: Number(row.created_at),
            stats,
          },
        }, 200, { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Delete document cascade
    if (path.match(/^\/api\/documents\/([^/]+)$/) && request.method === "DELETE") {
      const match = path.match(/^\/api\/documents\/([^/]+)$/);
      const docId = match ? match[1] : "";

      try {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ success: false, error: "غير مصرح." }, 401);
        }

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        // Mark as deleted
        await client.execute({
          sql: "UPDATE documents SET is_deleted = 1, updated_at = ? WHERE id = ?",
          args: [Date.now(), docId],
        });

        // Cascade delete file stats in Turso
        await cascadeDeleteFileStats(docId, env);

        // Bump content_versions for documents
        await bumpContentVersion(client, "documents");

        // Record audit log
        await client.execute({
          sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
                VALUES (?, ?, 'DELETE_DOCUMENT', 'document', ?, ?, ?)`,
          args: [`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, user.id || user.username || "unknown", docId, "cascade deleted", Date.now()],
        });

        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Analytics Engine View point (zero Turso writes)
    if (path.match(/^\/api\/documents\/([^/]+)\/view$/) && request.method === "POST") {
      const match = path.match(/^\/api\/documents\/([^/]+)\/view$/);
      const fileId = match ? match[1] : "";

      recordFileView(env, fileId, "doc_detail");
      const stats = await getFileStats(fileId, env);

      return jsonResponse({ success: true, stats }, 200, {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
      });
    }

    // Analytics Engine Download point (zero Turso writes)
    if (path.match(/^\/api\/documents\/([^/]+)\/download$/) && request.method === "POST") {
      const match = path.match(/^\/api\/documents\/([^/]+)\/download$/);
      const fileId = match ? match[1] : "";

      recordDownloadRequest(env, fileId, "download_link");
      return jsonResponse({ success: true, recorded: true }, 200, { "Cache-Control": "no-store" });
    }

    // Document Public Stats Read
    if (path.match(/^\/api\/documents\/([^/]+)\/stats$/) && request.method === "GET") {
      const match = path.match(/^\/api\/documents\/([^/]+)\/stats$/);
      const fileId = match ? match[1] : "";
      const stats = await getFileStats(fileId, env);
      return jsonResponse({ success: true, stats }, 200, {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
      });
    }

    // ==========================================
    // 2. Announcements Endpoints
    // (Edge TTL: 180s per contract, with ETag 304 and strict attachment rules)
    // ==========================================

    if (path === "/api/announcements" && request.method === "GET") {
      try {
        const { getDatabaseClient } = await import("../db/client");
        const { ensureAnalyticsSchema } = await import("../db/ensureSchema");
        await ensureAnalyticsSchema(env);
        const client = getDatabaseClient(env);

        const version = await getContentVersion(client, "announcements");
        const etag = `W/"ann-v${version}"`;

        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              ...CORS_HEADERS,
              "ETag": etag,
              "Cache-Control": "public, max-age=180, stale-while-revalidate=60",
            },
          });
        }

        const res = await client.execute({
          sql: "SELECT id, title, content, type, target_branches, is_pinned, author_id, file_url, corrige_url, created_at, updated_at FROM announcements WHERE is_published = 1 ORDER BY is_pinned DESC, created_at DESC LIMIT 50",
          args: [],
        });

        const announcements = res.rows.map((r) => ({
          id: String(r.id),
          title: String(r.title),
          content: String(r.content),
          type: String(r.type),
          targetBranches: r.target_branches ? String(r.target_branches).split(",") : [],
          isPinned: Boolean(r.is_pinned),
          authorId: String(r.author_id),
          fileUrl: r.type === "live_class" ? (r.file_url ? String(r.file_url) : null) : null,
          corrigeUrl: r.type === "live_class" ? (r.corrige_url ? String(r.corrige_url) : null) : null,
          createdAt: Number(r.created_at),
        }));

        return jsonResponse({ success: true, announcements }, 200, {
          "Cache-Control": "public, max-age=180, stale-while-revalidate=60",
          "ETag": etag,
          "X-Content-Version": String(version),
        });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/announcements" && request.method === "POST") {
      try {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ success: false, error: "يجب تسجيل الدخول لنشر الإعلانات." }, 401);
        }

        const body = (await request.json()) as any;
        const type = body.type || "announcement";

        // Validate permissions
        if (["tip"].includes(type)) {
          if (!["elite_student", "teacher", "superadmin"].includes(user.role)) {
            return jsonResponse({ success: false, error: "صلاحية غير كافية لنشر هذه النصيحة." }, 403);
          }
        } else {
          if (!["teacher", "superadmin"].includes(user.role)) {
            return jsonResponse({ success: false, error: "فقط الأساتذة والإدارة يمكنهم نشر هذا النوع من الإعلانات." }, 403);
          }
        }

        const content = (body.content || "").trim();
        const title = (body.title || "").trim();
        if (!content) {
          return jsonResponse({ success: false, error: "نص الإعلان مطلوب." }, 400);
        }

        let fileUrl: string | null = null;
        let corrigeUrl: string | null = null;

        if (type === "live_class") {
          fileUrl = body.fileUrl || body.pdfAttachmentUrl || null;
          corrigeUrl = null;
        }

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const annId = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const now = Date.now();
        const branches = Array.isArray(body.targetBranches) ? body.targetBranches.join(",") : (body.targetBranches || "all");

        await client.execute({
          sql: `INSERT INTO announcements (id, title, content, type, target_branches, is_pinned, is_published, author_id, file_url, corrige_url, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          args: [annId, title || "إعلان", content, type, branches, body.isPinned ? 1 : 0, user.id || "author", fileUrl, corrigeUrl, now, now],
        });

        // Bump content_versions for announcements
        await bumpContentVersion(client, "announcements");

        // Telegram Backup for live_class attachment
        if (type === "live_class" && fileUrl) {
          ctx.waitUntil(
            backupPdfToTelegram(
              {
                fileUrl,
                fileName: `${title || "Live_Class"}_Attachment.pdf`,
                title: title || "مرفق الحصة المباشرة",
                docId: annId,
                author: user.displayName || user.username,
              },
              env
            ).catch((err) => {
              console.warn("[Telegram Backup] Asynchronous announcement backup error:", err);
            })
          );
        }

        const ann = {
          id: annId,
          title: title || "إعلان",
          content,
          type,
          targetBranches: branches === "all" ? [] : branches.split(","),
          isPinned: Boolean(body.isPinned),
          authorId: user.id || "author",
          fileUrl,
          corrigeUrl,
          createdAt: now,
        };

        return jsonResponse({ success: true, announcement: ann }, 201);
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path.match(/^\/api\/announcements\/([^/]+)$/) && request.method === "PATCH") {
      const match = path.match(/^\/api\/announcements\/([^/]+)$/);
      const annId = match ? match[1] : "";

      try {
        const user = await getAuthUser(request, env);
        if (!user) return jsonResponse({ success: false, error: "غير مصرح." }, 401);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        const existing = await client.execute({
          sql: "SELECT author_id, type FROM announcements WHERE id = ?",
          args: [annId],
        });
        if (existing.rows.length === 0) {
          return jsonResponse({ success: false, error: "الإعلان غير موجود." }, 404);
        }

        const isOwnerOrAuthor =
          user.role === "superadmin" ||
          user.email.toLowerCase() === "learningmyj20@gmail.com" ||
          (user.id && String(existing.rows[0].author_id) === String(user.id));
        if (!isOwnerOrAuthor) {
          return jsonResponse({ success: false, error: "غير مصرح لك بتعديل هذا الإعلان." }, 403);
        }

        const body = (await request.json()) as any;
        const currentType = String(existing.rows[0].type);

        let corrigeUrl: string | null = null;
        let fileUrl: string | null = null;
        if (currentType === "live_class") {
          if (body.corrigeUrl || body.correctionPdfs) {
            corrigeUrl = body.corrigeUrl || (body.correctionPdfs && body.correctionPdfs[0]?.url) || null;
          }
          if (body.fileUrl || body.pdfAttachments) {
            fileUrl = body.fileUrl || (body.pdfAttachments && body.pdfAttachments[0]?.url) || null;
          }
        }

        await client.execute({
          sql: `UPDATE announcements 
                SET title = COALESCE(?, title), 
                    content = COALESCE(?, content),
                    file_url = COALESCE(?, file_url),
                    corrige_url = COALESCE(?, corrige_url),
                    updated_at = ?
                WHERE id = ?`,
          args: [body.title || null, body.content || null, fileUrl, corrigeUrl, Date.now(), annId],
        });

        // Bump content_versions for announcements
        await bumpContentVersion(client, "announcements");

        // Telegram Backup for correction PDF
        if (corrigeUrl) {
          ctx.waitUntil(
            backupPdfToTelegram(
              {
                fileUrl: corrigeUrl,
                fileName: "Live_Class_Correction.pdf",
                title: "إصلاح الحصة المباشرة",
                docId: `${annId}_corrige`,
                author: user.displayName || user.username,
              },
              env
            ).catch((err) => {
              console.warn("[Telegram Backup] Asynchronous announcement correction backup error:", err);
            })
          );
        }

        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path.match(/^\/api\/announcements\/([^/]+)$/) && request.method === "DELETE") {
      const match = path.match(/^\/api\/announcements\/([^/]+)$/);
      const annId = match ? match[1] : "";

      try {
        const user = await getAuthUser(request, env);
        if (!user) return jsonResponse({ success: false, error: "غير مصرح." }, 401);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        await client.execute({
          sql: "DELETE FROM announcements WHERE id = ?",
          args: [annId],
        });

        // Bump content_versions for announcements
        await bumpContentVersion(client, "announcements");

        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // ==========================================
    // 3. Admin & Moderation Endpoints
    // (Strictly private, no-store, session revocation on ban/demote)
    // ==========================================

    // Dynamic Admin Settings
    if (path === "/api/admin/settings" && request.method === "PATCH") {
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const body = (await request.json()) as any;
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const now = Date.now();

        if (body.invite_only_active !== undefined) {
          await client.execute({
            sql: "UPDATE system_config SET value = ?, updated_at = ? WHERE key = 'invite_only_active'",
            args: [body.invite_only_active ? "true" : "false", now],
          });
        }
        if (body.daily_registration_cap !== undefined) {
          await client.execute({
            sql: "UPDATE system_config SET value = ?, updated_at = ? WHERE key = 'daily_registration_cap'",
            args: [String(body.daily_registration_cap), now],
          });
        }
        if (body.invite_code !== undefined) {
          await client.execute({
            sql: "UPDATE system_config SET value = ?, updated_at = ? WHERE key = 'invite_code'",
            args: [String(body.invite_code).trim(), now],
          });
        }

        // Audit log
        await client.execute({
          sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
                VALUES (?, ?, 'UPDATE_SETTINGS', 'system', 'system_config', ?, ?)`,
          args: [`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, adminUser.id || adminUser.username || "admin", JSON.stringify(body), now],
        });

        return jsonResponse({ success: true, message: "تم تحديث إعدادات النظام بنجاح دون الحاجة لإعادة النشر." });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Invitations Management
    if (path === "/api/admin/invitations" && request.method === "GET") {
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const res = await client.execute("SELECT id, code_hash, created_by, max_uses, uses_count, expires_at, created_at FROM invitations ORDER BY created_at DESC LIMIT 100");
        const invitations = res.rows.map((r) => ({
          id: String(r.id),
          codeHash: String(r.code_hash),
          createdBy: String(r.created_by),
          maxUses: Number(r.max_uses),
          usesCount: Number(r.uses_count),
          expiresAt: r.expires_at ? Number(r.expires_at) : null,
          createdAt: Number(r.created_at),
        }));
        return jsonResponse({ success: true, invitations });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/admin/invitations" && request.method === "POST") {
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const body = (await request.json()) as any;
        const code = (body.code || `BAC_${Math.random().toString(36).slice(2, 8).toUpperCase()}`).trim();
        const maxUses = parseInt(body.maxUses || "10", 10);
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const { hashPassword } = await import("../utils/cryptoAuth");
        const codeHash = await hashPassword(code);
        const invId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        await client.execute({
          sql: "INSERT INTO invitations (id, code_hash, created_by, max_uses, uses_count, created_at) VALUES (?, ?, ?, ?, 0, ?)",
          args: [invId, codeHash, adminUser.email, maxUses, Date.now()],
        });

        return jsonResponse({ success: true, id: invId, plainCode: code, maxUses }, 201);
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path.match(/^\/api\/admin\/invitations\/([^/]+)$/) && request.method === "DELETE") {
      const match = path.match(/^\/api\/admin\/invitations\/([^/]+)$/);
      const invId = match ? match[1] : "";
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        await client.execute({ sql: "DELETE FROM invitations WHERE id = ?", args: [invId] });
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/admin/users" && request.method === "GET") {
      try {
        const user = await getAuthUser(request, env);
        if (!isAdmin(user)) return jsonResponse({ success: false, error: "غير مصرح." }, 403);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        const role = url.searchParams.get("role") || "";
        const status = url.searchParams.get("status") || "";
        const search = url.searchParams.get("search") || "";

        let sql = "SELECT id, email_normalized, username_normalized, display_name, role, branch, grade_level, can_upload, status, created_at, last_login_at FROM users WHERE 1=1";
        const args: any[] = [];

        if (role && role !== "all") {
          sql += " AND role = ?";
          args.push(role);
        }
        if (status && status !== "all") {
          sql += " AND status = ?";
          args.push(status);
        }
        if (search) {
          sql += " AND (email_normalized LIKE ? OR username_normalized LIKE ? OR display_name LIKE ?)";
          args.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`, `%${search}%`);
        }

        sql += " ORDER BY created_at DESC LIMIT 200";

        const res = await client.execute({ sql, args });
        const users = res.rows.map((r) => ({
          id: String(r.id),
          email: String(r.email_normalized),
          username: String(r.username_normalized),
          displayName: String(r.display_name),
          role: String(r.role) as UserRole,
          branch: String(r.branch),
          gradeLevel: String(r.grade_level),
          canUpload: Boolean(r.can_upload),
          status: String(r.status),
          banned: r.status === "suspended",
          createdAt: Number(r.created_at),
          lastLoginAt: r.last_login_at ? Number(r.last_login_at) : null,
        }));

        return jsonResponse({ success: true, users, count: users.length }, 200, { "Cache-Control": "private, no-store" });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Ban User (Immediately revokes active sessions)
    if (path.match(/^\/api\/admin\/users\/([^/]+)\/ban$/) && request.method === "POST") {
      const match = path.match(/^\/api\/admin\/users\/([^/]+)\/ban$/);
      const targetUserId = match ? match[1] : "";

      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        // Update status to suspended
        await client.execute({
          sql: "UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ? OR email_normalized = ?",
          args: [Date.now(), targetUserId, targetUserId.toLowerCase()],
        });

        // Revoke all active sessions for this user immediately
        await client.execute({
          sql: "DELETE FROM sessions WHERE user_id = ? OR user_id IN (SELECT id FROM users WHERE email_normalized = ?)",
          args: [targetUserId, targetUserId.toLowerCase()],
        });

        // Audit log
        await client.execute({
          sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
                VALUES (?, ?, 'BAN_USER', 'user', ?, 'User banned and all sessions revoked immediately', ?)`,
          args: [`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, adminUser.id || adminUser.username || "admin", targetUserId, Date.now()],
        });

        return jsonResponse({ success: true, message: "تم حظر المستخدم وإلغاء جميع جلساته النشطة فوراً." });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Unban User
    if (path.match(/^\/api\/admin\/users\/([^/]+)\/unban$/) && request.method === "POST") {
      const match = path.match(/^\/api\/admin\/users\/([^/]+)\/unban$/);
      const targetUserId = match ? match[1] : "";

      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        await client.execute({
          sql: "UPDATE users SET status = 'active', updated_at = ? WHERE id = ? OR email_normalized = ?",
          args: [Date.now(), targetUserId, targetUserId.toLowerCase()],
        });

        // Audit log
        await client.execute({
          sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
                VALUES (?, ?, 'UNBAN_USER', 'user', ?, 'User unbanned', ?)`,
          args: [`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, adminUser.id || adminUser.username || "admin", targetUserId, Date.now()],
        });

        return jsonResponse({ success: true, message: "تم إلغاء حظر المستخدم بنجاح." });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Force Logout user sessions
    if (path.match(/^\/api\/admin\/users\/([^/]+)\/force-logout$/) && request.method === "POST") {
      const match = path.match(/^\/api\/admin\/users\/([^/]+)\/force-logout$/);
      const targetUserId = match ? match[1] : "";

      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        await client.execute({
          sql: "DELETE FROM sessions WHERE user_id = ? OR user_id IN (SELECT id FROM users WHERE email_normalized = ?)",
          args: [targetUserId, targetUserId.toLowerCase()],
        });

        await client.execute({
          sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
                VALUES (?, ?, 'FORCE_LOGOUT', 'user', ?, 'All sessions revoked by admin', ?)`,
          args: [`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, adminUser.id || adminUser.username || "admin", targetUserId, Date.now()],
        });

        return jsonResponse({ success: true, message: "تم تسجيل خروج المستخدم من كافة الأجهزة والجلسات." });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Update Role & Permissions (Revokes sessions if role is modified)
    if (path.match(/^\/api\/admin\/users\/([^/]+)\/role$/) && request.method === "POST") {
      const match = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
      const targetUserId = match ? match[1] : "";

      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const body = (await request.json()) as any;
        const newRole = body.role as UserRole | undefined;
        const canUpload = typeof body.canUpload === "boolean" ? (body.canUpload ? 1 : 0) : undefined;

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        if (newRole && canUpload !== undefined) {
          await client.execute({
            sql: "UPDATE users SET role = ?, can_upload = ?, updated_at = ? WHERE id = ? OR email_normalized = ?",
            args: [newRole, canUpload, Date.now(), targetUserId, targetUserId.toLowerCase()],
          });
        } else if (newRole) {
          await client.execute({
            sql: "UPDATE users SET role = ?, updated_at = ? WHERE id = ? OR email_normalized = ?",
            args: [newRole, Date.now(), targetUserId, targetUserId.toLowerCase()],
          });
        } else if (canUpload !== undefined) {
          await client.execute({
            sql: "UPDATE users SET can_upload = ?, updated_at = ? WHERE id = ? OR email_normalized = ?",
            args: [canUpload, Date.now(), targetUserId, targetUserId.toLowerCase()],
          });
        }

        // Revoke active sessions on role change so fresh credentials take effect
        if (newRole) {
          await client.execute({
            sql: "DELETE FROM sessions WHERE user_id = ? OR user_id IN (SELECT id FROM users WHERE email_normalized = ?)",
            args: [targetUserId, targetUserId.toLowerCase()],
          });
        }

        // Audit log
        await client.execute({
          sql: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at)
                VALUES (?, ?, 'UPDATE_ROLE', 'user', ?, ?, ?)`,
          args: [`audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, adminUser.id || adminUser.username || "admin", targetUserId, JSON.stringify({ newRole, canUpload }), Date.now()],
        });

        return jsonResponse({ success: true, message: "تم تحديث الصلاحيات وإلغاء الجلسات القديمة للتجديد." });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Delete User
    if (path.match(/^\/api\/admin\/users\/([^/]+)$/) && request.method === "DELETE") {
      const match = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      const targetUserId = match ? match[1] : "";

      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        await client.execute({
          sql: "DELETE FROM sessions WHERE user_id = ? OR user_id IN (SELECT id FROM users WHERE email_normalized = ?)",
          args: [targetUserId, targetUserId.toLowerCase()],
        });

        await client.execute({
          sql: "DELETE FROM users WHERE id = ? OR email_normalized = ?",
          args: [targetUserId, targetUserId.toLowerCase()],
        });

        return jsonResponse({ success: true, message: "تم حذف المستخدم بنجاح." });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Admin Audit Logs
    if (path === "/api/admin/audit-logs" && request.method === "GET") {
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        const res = await client.execute({
          sql: "SELECT id, actor_id, action, target_type, target_id, details, created_at FROM audit_log ORDER BY created_at DESC LIMIT 100",
          args: [],
        });

        const logs = res.rows.map((r) => ({
          id: String(r.id),
          actorId: String(r.actor_id),
          action: String(r.action),
          targetType: String(r.target_type),
          targetId: String(r.target_id),
          details: r.details ? String(r.details) : "",
          createdAt: Number(r.created_at),
        }));

        return jsonResponse({ success: true, logs });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Feedback Endpoints
    if (path === "/api/admin/feedbacks" && request.method === "GET") {
      try {
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const res = await client.execute("SELECT id, user_id, email, full_name, category, message, resolved, created_at FROM student_feedbacks ORDER BY created_at DESC LIMIT 100");
        const feedbacks = res.rows.map((r) => ({
          id: String(r.id),
          userId: r.user_id ? String(r.user_id) : "",
          email: r.email ? String(r.email) : "",
          fullName: r.full_name ? String(r.full_name) : "",
          category: r.category ? String(r.category) : "عام",
          message: String(r.message),
          resolved: Boolean(r.resolved),
          createdAt: Number(r.created_at),
        }));
        return jsonResponse({ success: true, feedbacks });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/feedbacks" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const id = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await client.execute({
          sql: "INSERT INTO student_feedbacks (id, user_id, email, full_name, category, message, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
          args: [id, body.userId || null, body.email || null, body.fullName || null, body.category || "عام", body.message || "", Date.now()],
        });
        return jsonResponse({ success: true, id }, 201);
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path.match(/^\/api\/admin\/feedbacks\/([^/]+)\/resolve$/) && request.method === "POST") {
      const match = path.match(/^\/api\/admin\/feedbacks\/([^/]+)\/resolve$/);
      const fbId = match ? match[1] : "";
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const resolved = body.resolved !== undefined ? (body.resolved ? 1 : 0) : 1;
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        await client.execute({
          sql: "UPDATE student_feedbacks SET resolved = ? WHERE id = ?",
          args: [resolved, fbId],
        });
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path.match(/^\/api\/admin\/feedbacks\/([^/]+)$/) && request.method === "DELETE") {
      const match = path.match(/^\/api\/admin\/feedbacks\/([^/]+)$/);
      const fbId = match ? match[1] : "";
      try {
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        await client.execute({ sql: "DELETE FROM student_feedbacks WHERE id = ?", args: [fbId] });
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Elite Applications Endpoints
    if (path === "/api/admin/elite-applications" && request.method === "GET") {
      try {
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const res = await client.execute("SELECT id, username, email, applicant_role, specialty, discord_username, branch, status, proof_url, reviewed_by, reviewed_at, created_at FROM elite_applications ORDER BY created_at DESC LIMIT 100");
        const applications = res.rows.map((r) => ({
          id: String(r.id),
          username: String(r.username),
          email: String(r.email),
          applicantRole: String(r.applicant_role),
          specialty: r.specialty ? String(r.specialty) : "",
          discordUsername: r.discord_username ? String(r.discord_username) : "",
          branch: r.branch ? String(r.branch) : "",
          status: String(r.status),
          proofUrl: r.proof_url ? String(r.proof_url) : "",
          reviewedBy: r.reviewed_by ? String(r.reviewed_by) : "",
          reviewedAt: r.reviewed_at ? Number(r.reviewed_at) : null,
          createdAt: Number(r.created_at),
        }));
        return jsonResponse({ success: true, applications });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/elite-applications" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const id = `elite_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await client.execute({
          sql: "INSERT INTO elite_applications (id, username, email, applicant_role, specialty, discord_username, branch, status, proof_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
          args: [id, body.username, body.email, body.applicantRole || "student", body.specialty || null, body.discordUsername || null, body.branch || null, body.proofUrl || null, Date.now()],
        });
        return jsonResponse({ success: true, id }, 201);
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path.match(/^\/api\/admin\/elite-applications\/([^/]+)\/review$/) && request.method === "POST") {
      const match = path.match(/^\/api\/admin\/elite-applications\/([^/]+)\/review$/);
      const appId = match ? match[1] : "";
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const body = (await request.json()) as any;
        const newStatus = body.status === "approved" ? "approved" : "rejected";

        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        const appRes = await client.execute({ sql: "SELECT email, applicant_role FROM elite_applications WHERE id = ?", args: [appId] });
        if (appRes.rows.length === 0) return jsonResponse({ success: false, error: "الطلب غير موجود." }, 404);

        const targetEmail = String(appRes.rows[0].email);
        const applicantRole = String(appRes.rows[0].applicant_role);

        await client.execute({
          sql: "UPDATE elite_applications SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
          args: [newStatus, adminUser.email, Date.now(), appId],
        });

        if (newStatus === "approved") {
          const roleToAssign: UserRole = applicantRole === "professor" || applicantRole === "teacher" ? "teacher" : "elite_student";
          await client.execute({
            sql: "UPDATE users SET role = ?, can_upload = 1, updated_at = ? WHERE email_normalized = ?",
            args: [roleToAssign, Date.now(), targetEmail.toLowerCase()],
          });
        }

        return jsonResponse({ success: true, status: newStatus });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Dynamic FAQs Endpoints
    if (path === "/api/faqs" && request.method === "GET") {
      try {
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        const res = await client.execute("SELECT id, question, answer, category, author_email, author_role, created_at FROM dynamic_faqs ORDER BY created_at ASC");
        const faqs = res.rows.map((r) => ({
          id: String(r.id),
          question: String(r.question),
          answer: String(r.answer),
          category: String(r.category || "عام"),
          authorEmail: r.author_email ? String(r.author_email) : "",
          authorRole: r.author_role ? (String(r.author_role) as UserRole) : "member",
          createdAt: Number(r.created_at),
        }));
        return jsonResponse({ success: true, faqs }, 200, { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path === "/api/admin/faqs" && request.method === "POST") {
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);

        const body = (await request.json()) as any;
        const id = body.id || `faq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);

        await client.execute({
          sql: `INSERT INTO dynamic_faqs (id, question, answer, category, author_email, author_role, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET question = excluded.question, answer = excluded.answer, category = excluded.category`,
          args: [id, body.question, body.answer, body.category || "عام", adminUser.email, adminUser.role, Date.now()],
        });

        return jsonResponse({ success: true, id }, 201);
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    if (path.match(/^\/api\/admin\/faqs\/([^/]+)$/) && request.method === "DELETE") {
      const match = path.match(/^\/api\/admin\/faqs\/([^/]+)$/);
      const faqId = match ? match[1] : "";
      try {
        const adminUser = await getAuthUser(request, env);
        if (!isAdmin(adminUser)) return jsonResponse({ success: false, error: "صلاحية المشرف مطلوبة." }, 403);
        const { getDatabaseClient } = await import("../db/client");
        const client = getDatabaseClient(env);
        await client.execute({ sql: "DELETE FROM dynamic_faqs WHERE id = ?", args: [faqId] });
        return jsonResponse({ success: true });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // Admin Analytics & Sync endpoints
    if (path === "/api/admin/analytics" && request.method === "GET") {
      const summary = await getAdminAnalyticsSummary(env);
      return jsonResponse({ success: true, summary }, 200, { "Cache-Control": "private, no-store" });
    }

    if (path === "/api/admin/documents/publish" && request.method === "POST") {
      try {
        const body = (await request.json()) as { fileId: string };
        const result = await initFileStats(body.fileId, env);
        return jsonResponse(result, result.success ? 200 : 400);
      } catch {
        return jsonResponse({ success: false, error: "Invalid payload" }, 400);
      }
    }

    if (path.match(/^\/api\/admin\/documents\/([^/]+)$/) && request.method === "DELETE") {
      const match = path.match(/^\/api\/admin\/documents\/([^/]+)$/);
      const fileId = match ? match[1] : "";
      const result = await cascadeDeleteFileStats(fileId, env);
      return jsonResponse(result, result.success ? 200 : 400);
    }

    if (path === "/api/admin/sync-now" && request.method === "POST") {
      const res = await runScheduledSync(env);
      return jsonResponse(res, res.success ? 200 : 500, { "Cache-Control": "private, no-store" });
    }

    // Default to serving static assets if bound (Cloudflare Workers Static Assets before Worker invocation)
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },
};
