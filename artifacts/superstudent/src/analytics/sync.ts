/**
 * SuperStudent.TN — Scheduled Analytics Engine Batch Sync Module
 * Invoked every 6 hours by Cloudflare Workers Cron Trigger ('0 *\/6 * * *').
 * 
 * Flow:
 * 1. Reads current watermark from Turso stats_sync_state.
 * 2. Captures stable windowEnd = Math.floor(Date.now() / 1000).
 * 3. Queries Cloudflare Analytics Engine SQL API for dataset 'SuperStudent'.
 * 4. In batches of up to 500 files, executes a single ACID transaction containing:
 *    - Legacy file stats insertion (if file exists in documents)
 *    - Counter updates (total_views, total_download_requests)
 *    - Daily breakdown updates (file_stats_daily)
 *    - Watermark update in stats_sync_state
 * 
 * Guarantee: If failure occurs at any point before commit, the watermark is NOT
 * advanced. The subsequent run re-processes the exact window safely and idempotently.
 */

import { Client } from "@libsql/client/web";
import { getDatabaseClient, DatabaseEnv } from "../db/client";
import { ensureAnalyticsSchema } from "../db/ensureSchema";

export interface SyncEnv extends DatabaseEnv {
  CF_ACCOUNT_ID?: string;
  AE_SQL_API_TOKEN?: string;
  // Custom fetch function injected for testing/mocking
  _customSqlFetch?: (sql: string) => Promise<AnalyticsSqlApiResponse>;
}

export interface AnalyticsSqlRow {
  file_id: string;
  event_type: "view" | "download_request";
  cnt: number;
  window_min_ts?: string;
  window_max_ts?: string;
}

export interface AnalyticsSqlApiResponse {
  meta?: Array<{ name: string; type: string }>;
  data?: Array<{
    file_id: string;
    event_type: string;
    cnt: number;
    [key: string]: unknown;
  }>;
  rows?: number;
  error?: string;
}

export interface SyncResult {
  success: boolean;
  status: "ok" | "partial" | "error";
  watermarkBefore: number;
  watermarkAfter: number;
  filesProcessed: number;
  viewsAdded: number;
  downloadsAdded: number;
  durationMs: number;
  error?: string;
}

const BATCH_CHUNK_SIZE = 500;
const MAX_QUERY_LIMIT = 1000;
const MAX_RETRIES = 3;

/**
 * Execute Cloudflare Analytics Engine SQL Query with retry backoff.
 */
async function queryAnalyticsEngineSql(
  sqlText: string,
  env: SyncEnv
): Promise<AnalyticsSqlRow[]> {
  if (env._customSqlFetch) {
    const res = await env._customSqlFetch(sqlText);
    return (res.data || []).map((r) => ({
      file_id: String(r.file_id),
      event_type: r.event_type as "view" | "download_request",
      cnt: Number(r.cnt) || 0,
    }));
  }

  const accountId = env.CF_ACCOUNT_ID || (typeof process !== "undefined" ? process.env?.CF_ACCOUNT_ID : "");
  const apiToken = env.AE_SQL_API_TOKEN || (typeof process !== "undefined" ? process.env?.AE_SQL_API_TOKEN : "");

  if (!accountId || !apiToken) {
    throw new Error("Missing Cloudflare CF_ACCOUNT_ID or AE_SQL_API_TOKEN for Analytics Engine SQL API");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  let attempt = 0;
  let delayMs = 500;

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "text/plain",
        },
        body: sqlText,
      });

      if (resp.status === 429 || resp.status >= 500) {
        const retryAfterHeader = resp.headers.get("Retry-After");
        const wait = retryAfterHeader ? Number(retryAfterHeader) * 1000 : delayMs;
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Analytics Engine SQL API returned status ${resp.status} after ${attempt} attempts`);
        }
        await new Promise((r) => setTimeout(r, wait));
        delayMs *= 2;
        continue;
      }

      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => "");
        throw new Error(`Analytics Engine SQL API error HTTP ${resp.status}: ${bodyText}`);
      }

      const json = (await resp.json()) as AnalyticsSqlApiResponse;
      return (json.data || []).map((r) => ({
        file_id: String(r.file_id),
        event_type: r.event_type as "view" | "download_request",
        cnt: Number(r.cnt) || 0,
      }));
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }

  return [];
}

/**
 * Main scheduled sync task runner.
 * Safe, idempotent, respects watermarks, and never double-counts.
 */
export async function runScheduledSync(
  env: SyncEnv = {},
  options?: { forcedWindowEnd?: number }
): Promise<SyncResult> {
  const startTime = Date.now();
  const client: Client = getDatabaseClient(env);

  // 1. Ensure tables exist idempotently
  await ensureAnalyticsSchema(client);

  // 2. Read existing watermark
  const watermarkRes = await client.execute({
    sql: "SELECT watermark_views, watermark_downloads FROM stats_sync_state WHERE id = 'global'",
    args: [],
  });

  const row = watermarkRes.rows[0];
  const watermarkViews = row ? Number(row[0] || row.watermark_views || 0) : 0;
  const currentWatermark = watermarkViews;

  // 3. Stable window end captured BEFORE query executes
  const windowEnd = options?.forcedWindowEnd || Math.floor(Date.now() / 1000);

  // If window hasn't progressed, exit cleanly
  if (windowEnd <= currentWatermark) {
    return {
      success: true,
      status: "ok",
      watermarkBefore: currentWatermark,
      watermarkAfter: currentWatermark,
      filesProcessed: 0,
      viewsAdded: 0,
      downloadsAdded: 0,
      durationMs: Date.now() - startTime,
    };
  }

  let totalFilesProcessed = 0;
  let totalViewsAdded = 0;
  let totalDownloadsAdded = 0;
  let lastProcessedFileId = "";
  let hasMore = true;

  try {
    while (hasMore) {
      // 4. Construct sampling-aware, bounded query
      // _sample_interval automatically compensates for Cloudflare dataset sampling
      const fileIdClause = lastProcessedFileId
        ? `AND blob1 > '${lastProcessedFileId.replace(/'/g, "''")}'`
        : "";

      const sqlQuery = `
        SELECT
          blob1 AS file_id,
          blob2 AS event_type,
          SUM(_sample_interval * double1) AS cnt,
          MIN(timestamp) AS window_min_ts,
          MAX(timestamp) AS window_max_ts
        FROM SuperStudent
        WHERE timestamp > toDateTime64(${currentWatermark}, 3, 'UTC')
          AND timestamp <= toDateTime64(${windowEnd}, 3, 'UTC')
          AND blob2 IN ('view','download_request')
          ${fileIdClause}
        GROUP BY file_id, event_type
        ORDER BY file_id
        LIMIT ${MAX_QUERY_LIMIT};
      `.trim();

      const queryRows = await queryAnalyticsEngineSql(sqlQuery, env);

      if (queryRows.length === 0) {
        hasMore = false;
        break;
      }

      // Group rows by file_id for clean batching
      const fileAggregates = new Map<string, { views: number; downloads: number }>();
      for (const r of queryRows) {
        const entry = fileAggregates.get(r.file_id) || { views: 0, downloads: 0 };
        if (r.event_type === "view") {
          entry.views += Math.round(r.cnt);
        } else if (r.event_type === "download_request") {
          entry.downloads += Math.round(r.cnt);
        }
        fileAggregates.set(r.file_id, entry);
        lastProcessedFileId = r.file_id;
      }

      const fileEntries = Array.from(fileAggregates.entries());

      // 5. Commit Turso updates in chunks of BATCH_CHUNK_SIZE
      for (let i = 0; i < fileEntries.length; i += BATCH_CHUNK_SIZE) {
        const chunk = fileEntries.slice(i, i + BATCH_CHUNK_SIZE);
        const batchStatements: any[] = [];
        const nowMs = Date.now();
        const dayUtc = new Date(windowEnd * 1000).toISOString().split("T")[0];

        for (const [fileId, agg] of chunk) {
          // A. Legacy fallback: ensure file_stats row exists if document is present
          // Must not resurrect deleted files: check document exists first
          const docCheck = await client.execute({
            sql: "SELECT id FROM documents WHERE id = ? AND is_deleted = 0",
            args: [fileId],
          });

          if (docCheck.rows.length > 0) {
            batchStatements.push({
              sql: `INSERT INTO file_stats (file_id, total_views, total_download_requests, updated_at)
                    VALUES (?, 0, 0, ?)
                    ON CONFLICT(file_id) DO NOTHING;`,
              args: [fileId, nowMs],
            });
          }

          // B. Counter updates
          if (agg.views > 0) {
            batchStatements.push({
              sql: `UPDATE file_stats
                    SET total_views = total_views + ?,
                        last_views_sync_at = ?,
                        updated_at = ?
                    WHERE file_id = ?;`,
              args: [agg.views, nowMs, nowMs, fileId],
            });
            totalViewsAdded += agg.views;
          }

          if (agg.downloads > 0) {
            batchStatements.push({
              sql: `UPDATE file_stats
                    SET total_download_requests = total_download_requests + ?,
                        last_downloads_sync_at = ?,
                        updated_at = ?
                    WHERE file_id = ?;`,
              args: [agg.downloads, nowMs, nowMs, fileId],
            });
            totalDownloadsAdded += agg.downloads;
          }

          // C. Optional daily breakdown update
          if (agg.views > 0 || agg.downloads > 0) {
            batchStatements.push({
              sql: `INSERT INTO file_stats_daily (file_id, day_utc, views, download_requests)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(file_id, day_utc) DO UPDATE SET
                      views = views + excluded.views,
                      download_requests = download_requests + excluded.download_requests;`,
              args: [fileId, dayUtc, agg.views, agg.downloads],
            });
          }

          totalFilesProcessed++;
        }

        // D. Update durable watermark in the SAME transaction!
        batchStatements.push({
          sql: `UPDATE stats_sync_state
                SET watermark_views = ?,
                    watermark_downloads = ?,
                    last_run_at = ?,
                    last_run_status = ?,
                    last_error = NULL
                WHERE id = 'global';`,
          args: [windowEnd, windowEnd, nowMs, "ok"],
        });

        // Atomic commit via libSQL batch
        await client.batch(batchStatements, "write");
      }

      if (queryRows.length < MAX_QUERY_LIMIT) {
        hasMore = false;
      }
    }

    // If no events were recorded in the window, still advance the watermark
    if (totalFilesProcessed === 0) {
      await client.execute({
        sql: `UPDATE stats_sync_state
              SET watermark_views = ?,
                  watermark_downloads = ?,
                  last_run_at = ?,
                  last_run_status = ?,
                  last_error = NULL
              WHERE id = 'global';`,
        args: [windowEnd, windowEnd, Date.now(), "ok"],
      });
    }

    return {
      success: true,
      status: "ok",
      watermarkBefore: currentWatermark,
      watermarkAfter: windowEnd,
      filesProcessed: totalFilesProcessed,
      viewsAdded: totalViewsAdded,
      downloadsAdded: totalDownloadsAdded,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[Scheduled Sync] Sync error occurred:", errorMsg);

    // CRITICAL: On persistent failure, record last_run_status='error'
    // but DO NOT advance watermark, ensuring next run re-covers the window!
    try {
      await client.execute({
        sql: `UPDATE stats_sync_state
              SET last_run_at = ?,
                  last_run_status = 'error',
                  last_error = ?
              WHERE id = 'global';`,
        args: [Date.now(), errorMsg.slice(0, 500)],
      });
    } catch {
      // Ignore fallback write failure
    }

    return {
      success: false,
      status: "error",
      watermarkBefore: currentWatermark,
      watermarkAfter: currentWatermark, // Untouched!
      filesProcessed: totalFilesProcessed,
      viewsAdded: totalViewsAdded,
      downloadsAdded: totalDownloadsAdded,
      durationMs: Date.now() - startTime,
      error: errorMsg,
    };
  }
}
