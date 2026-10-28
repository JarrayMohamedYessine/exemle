/**
 * SuperStudent.TN — Statistics Query & Read Service
 * 
 * Section 10 of Analytics Engine Specification:
 * - Student/public counters: fast indexed lookup from Turso file_stats
 * - Admin stats: read precomputed values (top viewed, top downloaded, totals)
 * - Cache policies:
 *   - Public document metadata: Cache-Control: public, max-age=300, stale-while-revalidate=60
 *   - Admin dashboards: Cache-Control: private, no-store
 */

import { Client } from "@libsql/client/web";
import { getDatabaseClient, DatabaseEnv } from "../db/client";
import { ensureAnalyticsSchema } from "../db/ensureSchema";

export interface FileStatsData {
  fileId: string;
  totalViews: number;
  totalDownloadRequests: number;
  lastViewsSyncAt: number | null;
  lastDownloadsSyncAt: number | null;
  updatedAt: number;
}

export interface AdminAnalyticsSummary {
  totalFilesTracked: number;
  totalViewsAllTime: number;
  totalDownloadRequestsAllTime: number;
  lastSyncAt: number | null;
  lastSyncStatus: string | null;
  topViewedFiles: Array<{
    fileId: string;
    totalViews: number;
    totalDownloadRequests: number;
  }>;
  topDownloadedFiles: Array<{
    fileId: string;
    totalViews: number;
    totalDownloadRequests: number;
  }>;
}

/**
 * Single-file indexed statistics reader for student/public document details.
 * Optimized for lowest row reads (indexed lookup, only needed columns).
 */
export async function getFileStats(
  fileId: string,
  env?: DatabaseEnv,
  existingClient?: Client
): Promise<FileStatsData | null> {
  try {
    if (!fileId) return null;
    const client = existingClient || getDatabaseClient(env);
    await ensureAnalyticsSchema(client);

    const res = await client.execute({
      sql: `SELECT file_id, total_views, total_download_requests, last_views_sync_at, last_downloads_sync_at, updated_at
            FROM file_stats
            WHERE file_id = ?
            LIMIT 1;`,
      args: [fileId],
    });

    if (res.rows.length === 0) {
      return null;
    }

    const r = res.rows[0];
    return {
      fileId: String(r[0] ?? r.file_id),
      totalViews: Number(r[1] ?? r.total_views ?? 0),
      totalDownloadRequests: Number(r[2] ?? r.total_download_requests ?? 0),
      lastViewsSyncAt: r[3] != null ? Number(r[3] ?? r.last_views_sync_at) : null,
      lastDownloadsSyncAt: r[4] != null ? Number(r[4] ?? r.last_downloads_sync_at) : null,
      updatedAt: Number(r[5] ?? r.updated_at ?? Date.now()),
    };
  } catch (err) {
    console.error(`[Stats Service] Error reading stats for file ${fileId}:`, err);
    return null;
  }
}

/**
 * Batch lookup of file statistics (for catalogue list views).
 */
export async function getBatchFileStats(
  fileIds: string[],
  env?: DatabaseEnv,
  existingClient?: Client
): Promise<Record<string, { totalViews: number; totalDownloadRequests: number }>> {
  const result: Record<string, { totalViews: number; totalDownloadRequests: number }> = {};
  if (!fileIds || fileIds.length === 0) return result;

  try {
    const client = existingClient || getDatabaseClient(env);
    await ensureAnalyticsSchema(client);

    // Limit batch to 100 to keep queries selective and cheap
    const safeIds = fileIds.slice(0, 100);
    const placeholders = safeIds.map(() => "?").join(",");

    const res = await client.execute({
      sql: `SELECT file_id, total_views, total_download_requests
            FROM file_stats
            WHERE file_id IN (${placeholders});`,
      args: safeIds,
    });

    for (const r of res.rows) {
      const id = String(r[0] ?? r.file_id);
      result[id] = {
        totalViews: Number(r[1] ?? r.total_views ?? 0),
        totalDownloadRequests: Number(r[2] ?? r.total_download_requests ?? 0),
      };
    }

    return result;
  } catch (err) {
    console.error("[Stats Service] Error in getBatchFileStats:", err);
    return result;
  }
}

/**
 * Admin dashboard overview stats reader (no-store, precomputed).
 */
export async function getAdminAnalyticsSummary(
  env?: DatabaseEnv,
  existingClient?: Client
): Promise<AdminAnalyticsSummary> {
  const client = existingClient || getDatabaseClient(env);
  await ensureAnalyticsSchema(client);

  try {
    // 1. Watermark and sync status
    const syncRes = await client.execute({
      sql: "SELECT last_run_at, last_run_status FROM stats_sync_state WHERE id = 'global'",
      args: [],
    });
    const syncRow = syncRes.rows[0];
    const lastSyncAt = syncRow ? (syncRow[0] != null ? Number(syncRow[0]) : null) : null;
    const lastSyncStatus = syncRow ? String(syncRow[1] || "initialized") : "initialized";

    // 2. Top viewed files
    const topViewsRes = await client.execute({
      sql: `SELECT file_id, total_views, total_download_requests
            FROM file_stats
            ORDER BY total_views DESC
            LIMIT 15;`,
      args: [],
    });
    const topViewedFiles = topViewsRes.rows.map((r) => ({
      fileId: String(r[0] ?? r.file_id),
      totalViews: Number(r[1] ?? r.total_views ?? 0),
      totalDownloadRequests: Number(r[2] ?? r.total_download_requests ?? 0),
    }));

    // 3. Top downloaded files
    const topDownloadsRes = await client.execute({
      sql: `SELECT file_id, total_views, total_download_requests
            FROM file_stats
            ORDER BY total_download_requests DESC
            LIMIT 15;`,
      args: [],
    });
    const topDownloadedFiles = topDownloadsRes.rows.map((r) => ({
      fileId: String(r[0] ?? r.file_id),
      totalViews: Number(r[1] ?? r.total_views ?? 0),
      totalDownloadRequests: Number(r[2] ?? r.total_download_requests ?? 0),
    }));

    // 4. Aggregate totals
    const aggRes = await client.execute({
      sql: `SELECT COUNT(*), SUM(total_views), SUM(total_download_requests)
            FROM file_stats;`,
      args: [],
    });
    const aggRow = aggRes.rows[0];
    const totalFilesTracked = aggRow ? Number(aggRow[0] || 0) : 0;
    const totalViewsAllTime = aggRow ? Number(aggRow[1] || 0) : 0;
    const totalDownloadRequestsAllTime = aggRow ? Number(aggRow[2] || 0) : 0;

    return {
      totalFilesTracked,
      totalViewsAllTime,
      totalDownloadRequestsAllTime,
      lastSyncAt,
      lastSyncStatus,
      topViewedFiles,
      topDownloadedFiles,
    };
  } catch (err) {
    console.error("[Stats Service] Error in getAdminAnalyticsSummary:", err);
    return {
      totalFilesTracked: 0,
      totalViewsAllTime: 0,
      totalDownloadRequestsAllTime: 0,
      lastSyncAt: null,
      lastSyncStatus: "error",
      topViewedFiles: [],
      topDownloadedFiles: [],
    };
  }
}
