/**
 * SuperStudent.TN — Database Client Module
 * Connects to Turso database 'superstudent' using @libsql/client.
 * Falls back to an in-memory client if TURSO_DATABASE_URL is not configured
 * (allowing local tests and development without external dependencies).
 */

import { createClient, Client } from "@libsql/client/web";

export interface DatabaseEnv {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

let cachedClient: Client | null = null;
let cachedConfigKey = "";

export function getDatabaseClient(env?: DatabaseEnv): Client {
  const url =
    env?.TURSO_DATABASE_URL ||
    (typeof process !== "undefined" ? process.env?.TURSO_DATABASE_URL : undefined) ||
    "";
  const authToken =
    env?.TURSO_AUTH_TOKEN ||
    (typeof process !== "undefined" ? process.env?.TURSO_AUTH_TOKEN : undefined) ||
    "";

  const configKey = `${url}::${authToken ? "authed" : "noauth"}`;

  if (cachedClient && cachedConfigKey === configKey) {
    return cachedClient;
  }

  if (url && (url.startsWith("libsql://") || url.startsWith("https://") || url.startsWith("http://"))) {
    cachedClient = createClient({
      url,
      authToken: authToken || undefined,
    });
    cachedConfigKey = configKey;
    return cachedClient;
  }

  // Local in-memory fallback for local dev / tests without live credentials
  if (!cachedClient || cachedConfigKey !== "memory") {
    cachedClient = createMemoryClient();
    cachedConfigKey = "memory";
  }
  return cachedClient;
}

/**
 * Creates a row object that behaves like libSQL Row (both array-indexed and property-accessible).
 */
function createLibsqlRow(columns: string[], values: unknown[]): any {
  const row = [...values] as any;
  columns.forEach((col, idx) => {
    row[col] = values[idx];
  });
  return row;
}

// Module-level in-memory storage for test/development persistence
const memoryTables = new Map<string, Map<string, Record<string, unknown>>>();

function getMemoryTable(name: string) {
  let t = memoryTables.get(name);
  if (!t) {
    t = new Map();
    memoryTables.set(name, t);
  }
  return t;
}

// Seed stats_sync_state default row
getMemoryTable("stats_sync_state").set("global", {
  id: "global",
  watermark_views: 0,
  watermark_downloads: 0,
  last_run_at: null,
  last_run_status: "initialized",
  last_error: null,
});

// Seed system_config default rows
const sysConfigTable = getMemoryTable("system_config");
if (!sysConfigTable.has("invite_only_active")) {
  sysConfigTable.set("invite_only_active", { key: "invite_only_active", value: "true" });
}
if (!sysConfigTable.has("invite_code")) {
  sysConfigTable.set("invite_code", { key: "invite_code", value: "BAC2025" });
}
if (!sysConfigTable.has("daily_registration_cap")) {
  sysConfigTable.set("daily_registration_cap", { key: "daily_registration_cap", value: "15000" });
}

// Seed content_versions default rows
const contentVerTable = getMemoryTable("content_versions");
if (!contentVerTable.has("documents")) {
  contentVerTable.set("documents", { id: "documents", version: 1, updated_at: 1761552000000 });
}
if (!contentVerTable.has("announcements")) {
  contentVerTable.set("announcements", { id: "announcements", version: 1, updated_at: 1761552000000 });
}

/**
 * Robust in-memory SQL mock implementing the Client interface
 * used when running in environments without an active Turso instance.
 */
function createMemoryClient(): Client {
  const memoryClient: any = {
    async execute(stmt: any) {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : stmt.args || [];
      const normalized = sql.trim().replace(/\s+/g, " ");

      // 1. DDL: CREATE TABLE / INDEX
      if (normalized.toUpperCase().startsWith("CREATE")) {
        return { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 2. schema_migrations
      if (normalized.includes("INSERT OR IGNORE INTO schema_migrations")) {
        const id = String(args[0]);
        const appliedAt = Number(args[1] || Date.now());
        const t = getMemoryTable("schema_migrations");
        if (!t.has(id)) {
          t.set(id, { id, applied_at: appliedAt });
          return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
        }
        return { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
      }

      if (normalized.includes("FROM schema_migrations")) {
        const t = getMemoryTable("schema_migrations");
        const cols = ["id", "applied_at"];
        const rows = Array.from(t.values()).map((r) => createLibsqlRow(cols, [r.id, r.applied_at]));
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 3. stats_sync_state
      if (normalized.includes("FROM stats_sync_state")) {
        const t = getMemoryTable("stats_sync_state");
        const rec = t.get("global") || {
          id: "global",
          watermark_views: 0,
          watermark_downloads: 0,
          last_run_at: null,
          last_run_status: "initialized",
          last_error: null,
        };

        // Determine requested columns dynamically
        const selectMatch = normalized.match(/SELECT\s+(.*?)\s+FROM\s+stats_sync_state/i);
        const colPart = selectMatch ? selectMatch[1].trim() : "*";
        let cols: string[] = [];

        if (colPart === "*") {
          cols = ["id", "watermark_views", "watermark_downloads", "last_run_at", "last_run_status", "last_error"];
        } else {
          cols = colPart.split(",").map((c: string) => c.trim().split(/\s+/)[0]);
        }

        const values = cols.map((col) => (rec as any)[col] ?? null);
        return {
          columns: cols,
          rows: [createLibsqlRow(cols, values)],
          rowsAffected: 0,
          lastInsertRowid: undefined,
        };
      }

      if (normalized.startsWith("UPDATE stats_sync_state SET") || normalized.includes("UPDATE stats_sync_state SET")) {
        const t = getMemoryTable("stats_sync_state");
        const rec = t.get("global") || { id: "global", watermark_views: 0, watermark_downloads: 0 };

        if (normalized.includes("last_error = ?") || normalized.includes("last_run_status = 'error'")) {
          // Failure update
          rec.last_run_at = args.length > 0 ? Number(args[0]) : Date.now();
          rec.last_run_status = "error";
          rec.last_error = args.length > 1 ? String(args[1]) : "Error";
        } else {
          // Success update: watermark_views, watermark_downloads, last_run_at, last_run_status
          rec.watermark_views = Number(args[0]);
          rec.watermark_downloads = Number(args[1]);
          rec.last_run_at = Number(args[2]);
          rec.last_run_status = String(args[3] || "ok");
          rec.last_error = null;
        }
        t.set("global", rec);
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }

      // 4. file_stats_daily
      if (normalized.includes("file_stats_daily")) {
        if (normalized.includes("DELETE FROM file_stats_daily")) {
          return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
        }
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }

      // 5. file_stats INSERT (strictly file_stats, not file_stats_daily)
      if (normalized.match(/INSERT (?:OR IGNORE )?INTO file_stats\s*\(/i)) {
        let fileId = String(args[0] || "");
        let views = args.length > 2 ? Number(args[1]) : 0;
        let downloads = args.length > 3 ? Number(args[2]) : 0;
        let updatedAt = args.length > 1 ? Number(args[args.length - 1]) : Date.now();

        // Support inline literals if args is empty
        if (!fileId) {
          const match = normalized.match(/VALUES\s*\(\s*'([^']+)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
          if (match) {
            fileId = match[1];
            views = Number(match[2]);
            downloads = Number(match[3]);
            updatedAt = Number(match[4]);
          }
        }

        const t = getMemoryTable("file_stats");
        if (fileId && !t.has(fileId)) {
          t.set(fileId, {
            file_id: fileId,
            total_views: views,
            total_download_requests: downloads,
            last_views_sync_at: null,
            last_downloads_sync_at: null,
            updated_at: updatedAt,
          });
          return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
        }
        return { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 6. file_stats UPDATE (strictly file_stats, not file_stats_daily)
      if (normalized.match(/^UPDATE\s+file_stats\s+SET/i) || normalized.match(/\bUPDATE\s+file_stats\s+SET/i)) {
        const t = getMemoryTable("file_stats");

        if (normalized.includes("total_views = total_views + ?") || normalized.includes("total_views = total_views +")) {
          const inc = Number(args[0]);
          const syncAt = Number(args[1]);
          const updatedAt = Number(args[2]);
          const fileId = String(args[3]);
          const row = t.get(fileId);
          // CRITICAL: An SQL UPDATE on non-existing row affects 0 rows, must NOT insert
          if (!row) {
            return { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
          }
          row.total_views = (Number(row.total_views) || 0) + inc;
          row.last_views_sync_at = syncAt;
          row.updated_at = updatedAt;
          t.set(fileId, row);
          return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
        } else if (normalized.includes("total_download_requests = total_download_requests + ?") || normalized.includes("total_download_requests = total_download_requests +")) {
          const inc = Number(args[0]);
          const syncAt = Number(args[1]);
          const updatedAt = Number(args[2]);
          const fileId = String(args[3]);
          const row = t.get(fileId);
          if (!row) {
            return { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
          }
          row.total_download_requests = (Number(row.total_download_requests) || 0) + inc;
          row.last_downloads_sync_at = syncAt;
          row.updated_at = updatedAt;
          t.set(fileId, row);
          return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
        } else {
          // Handle direct UPDATE with params or literals (e.g. UPDATE file_stats SET total_views = 120 WHERE file_id = 'x')
          let fileId = "";
          let views: number | undefined;
          let downloads: number | undefined;

          // Check for args
          if (args.length > 0) {
            fileId = String(args[args.length - 1]);
            views = Number(args[0]);
            if (args.length > 2) downloads = Number(args[1]);
          }

          // Check for inline literals
          const fileIdMatch = normalized.match(/WHERE\s+file_id\s*=\s*'([^']+)'/i);
          if (fileIdMatch) fileId = fileIdMatch[1];

          const viewsMatch = normalized.match(/total_views\s*=\s*(\d+)/i);
          if (viewsMatch) views = Number(viewsMatch[1]);

          const downloadsMatch = normalized.match(/total_download_requests\s*=\s*(\d+)/i);
          if (downloadsMatch) downloads = Number(downloadsMatch[1]);

          const row = t.get(fileId);
          if (!row) {
            return { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
          }
          if (views !== undefined) row.total_views = views;
          if (downloads !== undefined) row.total_download_requests = downloads;
          row.updated_at = Date.now();
          t.set(fileId, row);
          return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
        }
      }

      // 7. file_stats SELECT (strictly SELECT, not DELETE)
      if (normalized.match(/^SELECT\b.*?\bFROM\s+file_stats\s+WHERE\s+file_id\s*=/i)) {
        let fileId = String(args[0] || "");
        if (!fileId) {
          const match = normalized.match(/file_id\s*=\s*'([^']+)'/i);
          if (match) fileId = match[1];
        }
        const t = getMemoryTable("file_stats");
        const row = t.get(fileId);
        const cols = ["file_id", "total_views", "total_download_requests", "last_views_sync_at", "last_downloads_sync_at", "updated_at"];
        if (!row) {
          return { columns: cols, rows: [], rowsAffected: 0, lastInsertRowid: undefined };
        }
        const values = [row.file_id, row.total_views, row.total_download_requests, row.last_views_sync_at, row.last_downloads_sync_at, row.updated_at];
        return {
          columns: cols,
          rows: [createLibsqlRow(cols, values)],
          rowsAffected: 0,
          lastInsertRowid: undefined,
        };
      }

      if (normalized.includes("FROM file_stats WHERE file_id IN")) {
        const t = getMemoryTable("file_stats");
        const cols = ["file_id", "total_views", "total_download_requests"];
        const rows = args.map((id: any) => {
          const r = t.get(String(id));
          return r ? createLibsqlRow(cols, [r.file_id, r.total_views, r.total_download_requests]) : null;
        }).filter(Boolean);
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      if (normalized.includes("COUNT(*), SUM(total_views), SUM(total_download_requests)") || normalized.includes("COUNT(*)")) {
        const t = getMemoryTable("file_stats");
        let sumV = 0, sumD = 0;
        for (const row of t.values()) {
          sumV += Number(row.total_views) || 0;
          sumD += Number(row.total_download_requests) || 0;
        }
        const cols = ["count", "total_views", "total_downloads"];
        return {
          columns: cols,
          rows: [createLibsqlRow(cols, [t.size, sumV, sumD])],
          rowsAffected: 0,
          lastInsertRowid: undefined,
        };
      }

      if (normalized.includes("FROM file_stats ORDER BY total_views DESC")) {
        const t = getMemoryTable("file_stats");
        const sorted = Array.from(t.values()).sort((a, b) => Number(b.total_views) - Number(a.total_views));
        const limitMatch = normalized.match(/LIMIT\s+(\d+)/i);
        const limit = args.length > 0 ? Number(args[0]) : (limitMatch ? Number(limitMatch[1]) : 50);
        const cols = ["file_id", "total_views", "total_download_requests", "updated_at"];
        const rows = sorted.slice(0, limit).map((r) => createLibsqlRow(cols, [r.file_id, r.total_views, r.total_download_requests, r.updated_at]));
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      if (normalized.includes("FROM file_stats ORDER BY total_download_requests DESC")) {
        const t = getMemoryTable("file_stats");
        const sorted = Array.from(t.values()).sort((a, b) => Number(b.total_download_requests) - Number(a.total_download_requests));
        const limitMatch = normalized.match(/LIMIT\s+(\d+)/i);
        const limit = args.length > 0 ? Number(args[0]) : (limitMatch ? Number(limitMatch[1]) : 50);
        const cols = ["file_id", "total_views", "total_download_requests", "updated_at"];
        const rows = sorted.slice(0, limit).map((r) => createLibsqlRow(cols, [r.file_id, r.total_views, r.total_download_requests, r.updated_at]));
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 7. file_stats DELETE
      if (normalized.includes("DELETE FROM file_stats WHERE file_id =") || normalized.startsWith("DELETE FROM file_stats")) {
        let fileId = String(args[0] || "");
        if (!fileId) {
          const match = normalized.match(/file_id\s*=\s*'([^']+)'/i);
          if (match) fileId = match[1];
        }
        const t = getMemoryTable("file_stats");
        const existed = t.delete(fileId);
        getMemoryTable("file_stats_daily").delete(fileId);
        return { columns: [], rows: [], rowsAffected: existed ? 1 : 0, lastInsertRowid: undefined };
      }

      // 8. file_stats_daily
      if (normalized.includes("INSERT INTO file_stats_daily")) {
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("DELETE FROM file_stats_daily")) {
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }

      // 9. documents
      if (normalized.includes("FROM documents") && (normalized.includes("WHERE id = ?") || normalized.includes("WHERE id ="))) {
        let id = String(args[0] || "");
        if (!id) {
          const match = normalized.match(/id\s*=\s*'([^']+)'/i);
          if (match) id = match[1];
        }
        const t = getMemoryTable("documents");
        const row = t.get(id);
        const isDeletedCheck = normalized.includes("is_deleted = 0");
        const cols = ["id", "title", "subject_id", "branch_ids", "doc_type", "file_url", "corrige_url", "is_deleted", "created_at", "updated_at"];
        if (row && (!isDeletedCheck || !row.is_deleted)) {
          const vals = [row.id, row.title || "Doc", row.subject_id || "math", row.branch_ids || "math", row.doc_type || "exam", row.file_url || null, row.corrige_url || null, row.is_deleted || 0, row.created_at || Date.now(), row.updated_at || Date.now()];
          return { columns: cols, rows: [createLibsqlRow(cols, vals)], rowsAffected: 0, lastInsertRowid: undefined };
        }
        return { columns: cols, rows: [], rowsAffected: 0, lastInsertRowid: undefined };
      }

      if (normalized.includes("INSERT INTO documents")) {
        let id = "";
        let title = "Doc";
        let subjectId = "math";
        let branchIds = "math";
        let docType = "exam";
        let fileUrl: string | null = null;
        let corrigeUrl: string | null = null;
        let isDeleted = 0;
        let createdAt = Date.now();

        // Check if columns are explicitly named, e.g. INSERT INTO documents (id, title, is_deleted)
        const colsMatch = normalized.match(/INSERT\s+INTO\s+documents\s*\(([^)]+)\)/i);
        const colNames = colsMatch ? colsMatch[1].split(",").map((c: string) => c.trim().toLowerCase()) : [];

        if (args && args.length > 0) {
          if (colNames.length > 0) {
            colNames.forEach((col: string, idx: number) => {
              const val = args[idx];
              if (col === "id") id = String(val);
              else if (col === "title") title = String(val);
              else if (col === "subject_id") subjectId = String(val);
              else if (col === "branch_ids") branchIds = String(val);
              else if (col === "doc_type") docType = String(val);
              else if (col === "file_url") fileUrl = String(val);
              else if (col === "corrige_url") corrigeUrl = String(val);
              else if (col === "is_deleted") isDeleted = Number(val);
              else if (col === "created_at") createdAt = Number(val);
            });
          } else {
            id = String(args[0] || "");
            title = String(args[1] || "Doc");
            if (args.length > 2) subjectId = String(args[2]);
            if (args.length > 3) branchIds = String(args[3]);
            if (args.length > 4) docType = String(args[4]);
            if (args.length > 5) fileUrl = String(args[5]);
            if (args.length > 6) corrigeUrl = String(args[6]);
            if (args.length > 7) isDeleted = Number(args[7]);
            if (args.length > 8) createdAt = Number(args[8]);
          }
        } else {
          // Parse literal values in VALUES (...)
          const valuesMatch = normalized.match(/VALUES\s*\((.*?)\)/i);
          if (valuesMatch) {
            const rawParts = valuesMatch[1].split(",").map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""));
            if (colNames.length > 0) {
              colNames.forEach((col: string, idx: number) => {
                const val = rawParts[idx];
                if (val !== undefined) {
                  if (col === "id") id = val;
                  else if (col === "title") title = val;
                  else if (col === "subject_id") subjectId = val;
                  else if (col === "branch_ids") branchIds = val;
                  else if (col === "doc_type") docType = val;
                  else if (col === "file_url") fileUrl = val;
                  else if (col === "corrige_url") corrigeUrl = val;
                  else if (col === "is_deleted") isDeleted = Number(val) || 0;
                  else if (col === "created_at") createdAt = Number(val) || Date.now();
                }
              });
            } else {
              id = rawParts[0] || "";
              title = rawParts[1] || "Doc";
              if (rawParts.length > 2 && !isNaN(Number(rawParts[2]))) {
                isDeleted = Number(rawParts[2]);
              }
            }
          }
          const fileMatch = normalized.match(/'(https?:\/\/[^']+)'/);
          if (fileMatch) fileUrl = fileMatch[1];
        }

        const t = getMemoryTable("documents");
        t.set(id, { id, title, subject_id: subjectId, branch_ids: branchIds, doc_type: docType, file_url: fileUrl, corrige_url: corrigeUrl, is_deleted: isDeleted, created_at: createdAt });
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }

      if (normalized.includes("UPDATE documents SET is_deleted = 1")) {
        let id = args.length > 1 ? String(args[1]) : (args.length > 0 ? String(args[0]) : "");
        if (!id) {
          const match = normalized.match(/WHERE id = '([^']+)'/i);
          if (match) id = match[1];
        }
        const t = getMemoryTable("documents");
        const r = t.get(id);
        if (r) r.is_deleted = 1;
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }

      // 10. content_versions (for ETags & 304 revalidation)
      if (normalized.includes("FROM content_versions")) {
        const id = args.length > 0 ? String(args[0]) : (normalized.match(/id\s*=\s*'([^']+)'/i)?.[1] || "documents");
        const t = getMemoryTable("content_versions");
        const row = t.get(id) || { id, version: 1 };
        const cols = ["id", "version"];
        return { columns: cols, rows: [createLibsqlRow(cols, [row.id, row.version])], rowsAffected: 0, lastInsertRowid: undefined };
      }
      if (normalized.includes("content_versions") && (normalized.includes("UPDATE") || normalized.includes("INSERT"))) {
        const id = args.length > 0 ? String(args[0]) : "documents";
        const t = getMemoryTable("content_versions");
        const row = t.get(id) || { id, version: 1 };
        row.version = (Number(row.version) || 1) + 1;
        t.set(id, row);
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }

      // 11. system_config
      if (normalized.includes("FROM system_config")) {
        const t = getMemoryTable("system_config");
        const cols = ["key", "value"];
        const rows = Array.from(t.values()).map((r) => createLibsqlRow(cols, [r.key, r.value]));
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }
      if (normalized.includes("UPDATE system_config SET value =")) {
        const t = getMemoryTable("system_config");
        const keyMatch = normalized.match(/WHERE\s+key\s*=\s*'([^']+)'/i);
        const valMatch = normalized.match(/SET\s+value\s*=\s*'([^']+)'/i);
        if (keyMatch && valMatch) {
          t.set(keyMatch[1], { key: keyMatch[1], value: valMatch[1] });
        }
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }

      // 11. registration_daily_counter
      if (normalized.startsWith("DELETE FROM registration_daily_counter") || normalized.includes("DELETE FROM registration_daily_counter")) {
        const t = getMemoryTable("registration_daily_counter");
        if (args.length > 0) {
          t.delete(String(args[0]));
        } else {
          const match = normalized.match(/day_utc\s*=\s*'([^']+)'/i);
          if (match) {
            t.delete(match[1]);
          } else {
            t.clear();
          }
        }
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("INSERT INTO registration_daily_counter")) {
        const day = args.length > 0 ? String(args[0]) : (normalized.match(/VALUES\s*\(\s*'([^']+)'/i)?.[1] || "");
        const forcedCountMatch = normalized.match(/count\s*=\s*(\d+)/i);
        const t = getMemoryTable("registration_daily_counter");
        const existing = t.get(day);
        const countToSet = forcedCountMatch ? Number(forcedCountMatch[1]) : (existing ? Number(existing.count) + 1 : 1);
        t.set(day, { day_utc: day, count: countToSet });
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("UPDATE registration_daily_counter SET count =")) {
        const countMatch = normalized.match(/count\s*=\s*(\d+)/i);
        const count = countMatch ? Number(countMatch[1]) : (args.length > 0 ? Number(args[0]) : 15000);
        const day = args.length > 1 ? String(args[1]) : (args.length > 0 ? String(args[0]) : (normalized.match(/day_utc\s*=\s*'([^']+)'/i)?.[1] || ""));
        getMemoryTable("registration_daily_counter").set(day, { day_utc: day, count });
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("FROM registration_daily_counter")) {
        const day = args.length > 0 ? String(args[0]) : (normalized.match(/day_utc\s*=\s*'([^']+)'/i)?.[1] || "");
        const t = getMemoryTable("registration_daily_counter");
        const r = t.get(day);
        const cols = ["count"];
        const rows = r ? [createLibsqlRow(cols, [r.count])] : [];
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 12. sessions (DELETE & mutations MUST come before SELECT)
      if (normalized.startsWith("DELETE FROM sessions") || normalized.includes("DELETE FROM sessions")) {
        if (normalized.includes("WHERE id = ?") && args.length > 0) {
          getMemoryTable("sessions").delete(String(args[0]));
        } else {
          getMemoryTable("sessions").clear();
        }
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("INSERT INTO sessions")) {
        const sess = {
          id: String(args[0]),
          user_id: String(args[1]),
          created_at: Number(args[2]),
          expires_at: Number(args[3]),
          last_active_at: Number(args[4]),
        };
        getMemoryTable("sessions").set(sess.id, sess);
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("UPDATE sessions SET last_active_at =")) {
        const sessTable = getMemoryTable("sessions");
        const sid = String(args[1] || "");
        const s = sessTable.get(sid);
        if (s) s.last_active_at = Number(args[0]);
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("FROM sessions")) {
        const sessId = args.length > 0 ? String(args[0]) : "";
        const sessTable = getMemoryTable("sessions");
        const usersTable = getMemoryTable("users");
        const sess = sessTable.get(sessId);
        if (sess && Number(sess.expires_at) > Date.now()) {
          const u = usersTable.get(String(sess.user_id));
          if (u) {
            const cols = ["id", "email_normalized", "username_normalized", "display_name", "role", "branch", "grade_level", "avatar_url", "can_upload", "status", "created_at", "expires_at"];
            const values = [u.id, u.email_normalized, u.username_normalized, u.display_name, u.role, u.branch, u.grade_level, u.avatar_url, u.can_upload, u.status, u.created_at, sess.expires_at];
            return { columns: cols, rows: [createLibsqlRow(cols, values)], rowsAffected: 0, lastInsertRowid: undefined };
          }
        }
        return { columns: ["id"], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 13. users (DELETE & mutations MUST come before SELECT)
      if (normalized.startsWith("DELETE FROM users") || normalized.includes("DELETE FROM users")) {
        getMemoryTable("users").clear();
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("INSERT INTO users")) {
        const isSuperadmin = normalized.includes("'superadmin'");
        const role = isSuperadmin ? "superadmin" : "member";
        const canUpload = isSuperadmin ? 1 : 0;
        const userObj: any = {
          id: args[0],
          email_normalized: args[1],
          username_normalized: args[2],
          display_name: args[3],
          password_hash: args[4],
          role,
          branch: args[5] || "math",
          grade_level: "4eme_bac",
          avatar_url: null,
          can_upload: canUpload,
          status: "active",
          created_at: args[6] || Date.now(),
          updated_at: args[7] || Date.now(),
          last_login_at: args[8] || Date.now(),
        };
        getMemoryTable("users").set(String(userObj.id), userObj);
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("UPDATE users SET last_login_at =")) {
        const t = getMemoryTable("users");
        const uid = String(args[2]);
        const u = t.get(uid);
        if (u) {
          u.last_login_at = args[0];
          u.updated_at = args[1];
        }
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("FROM users")) {
        const t = getMemoryTable("users");
        const cols = [
          "id", "email_normalized", "username_normalized", "display_name",
          "password_hash", "role", "branch", "grade_level", "avatar_url",
          "can_upload", "status", "created_at", "updated_at", "last_login_at"
        ];

        // Check if query is looking specifically for superadmin
        if (normalized.includes("role = 'superadmin'")) {
          const match = Array.from(t.values()).find((u: any) => u.role === "superadmin");
          const rows = match ? [createLibsqlRow(cols, cols.map((c) => match[c] ?? null))] : [];
          return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
        }

        const idArg = args.length > 0 ? String(args[0]).toLowerCase() : "";
        const idArg2 = args.length > 1 ? String(args[1]).toLowerCase() : idArg;
        if (!idArg) {
          return { columns: cols, rows: [], rowsAffected: 0, lastInsertRowid: undefined };
        }
        const match = Array.from(t.values()).find(
          (u: any) =>
            String(u.id).toLowerCase() === idArg ||
            u.email_normalized === idArg ||
            u.username_normalized === idArg ||
            u.email_normalized === idArg2 ||
            u.username_normalized === idArg2
        );
        const rows = match ? [createLibsqlRow(cols, cols.map((c) => match[c] ?? null))] : [];
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 14. audit_log
      if (normalized.includes("INSERT INTO audit_log")) {
        const t = getMemoryTable("audit_log");
        const id = String(args[0] || "aud_" + Math.random().toString(36).slice(2));
        t.set(id, {
          id,
          actor_id: args[1],
          action: args[2],
          target_type: args[3],
          target_id: args[4],
          details: args[5],
          created_at: args[6] || Date.now(),
        });
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("FROM audit_log")) {
        const t = getMemoryTable("audit_log");
        const cols = ["id", "actor_id", "action", "target_type", "target_id", "details", "created_at"];
        const rows = Array.from(t.values()).map((r) => createLibsqlRow(cols, cols.map((c) => (r as any)[c] ?? null)));
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 15. announcements
      if (normalized.includes("INSERT INTO announcements")) {
        const t = getMemoryTable("announcements");
        const id = String(args[0] || "ann_" + Math.random().toString(36).slice(2));
        t.set(id, {
          id,
          title: args[1],
          content: args[2],
          type: args[3] || "general",
          target_branches: args[4] || null,
          is_pinned: Number(args[5] || 0),
          is_published: Number(args[6] || 1),
          author_id: args[7] || "author",
          file_url: args[8] || null,
          corrige_url: args[9] || null,
          created_at: args[10] || Date.now(),
          updated_at: args[11] || Date.now(),
        });
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("FROM announcements")) {
        const t = getMemoryTable("announcements");
        const cols = ["id", "title", "content", "type", "target_branches", "is_pinned", "is_published", "author_id", "file_url", "corrige_url", "created_at", "updated_at"];
        const rows = Array.from(t.values()).map((r) => createLibsqlRow(cols, cols.map((c) => (r as any)[c] ?? null)));
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      // 16. files
      if (normalized.includes("INSERT INTO files")) {
        const t = getMemoryTable("files");
        const id = String(args[0] || "file_" + Math.random().toString(36).slice(2));
        t.set(id, {
          id,
          document_id: args[1],
          provider: args[2],
          url: args[3],
          file_name: args[4],
          file_size: args[5],
          mime_type: args[6],
          created_at: args[7] || Date.now(),
        });
        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
      }
      if (normalized.includes("FROM files")) {
        const t = getMemoryTable("files");
        const cols = ["id", "document_id", "provider", "url", "file_name", "file_size", "mime_type", "created_at"];
        const rows = Array.from(t.values()).map((r) => createLibsqlRow(cols, cols.map((c) => (r as any)[c] ?? null)));
        return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
      }

      // Generic fallback
      return { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
    },

    async batch(stmts: any[]) {
      const results = [];
      for (const stmt of stmts) {
        results.push(await memoryClient.execute(stmt));
      }
      return results;
    },

    async transaction() {
      return {
        async execute(stmt: any) {
          return memoryClient.execute(stmt);
        },
        async commit() {},
        async rollback() {},
        async batch(stmts: any[]) {
          return memoryClient.batch(stmts);
        },
        async close() {},
      } as any;
    },

    close() {},
  };
  return memoryClient as Client;
}
