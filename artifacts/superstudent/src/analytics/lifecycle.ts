/**
 * SuperStudent.TN — Document & File Stats Lifecycle Operations
 * 
 * Section 6 of Analytics Engine Specification:
 * - Publication path: Creates empty file_stats record at publication time
 *   (keeping all view paths strictly read-only and free of database writes).
 * - Deletion cascade: Cleans up file_stats and file_stats_daily records
 *   in the same transaction when a document is deleted.
 */

import { Client } from "@libsql/client/web";
import { getDatabaseClient, DatabaseEnv } from "../db/client";
import { ensureAnalyticsSchema } from "../db/ensureSchema";

/**
 * Initializes a file_stats row for a newly published document.
 * Must be called in the publication flow with ON CONFLICT DO NOTHING.
 */
export async function initFileStats(
  fileId: string,
  env?: DatabaseEnv,
  existingClient?: Client
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!fileId) {
      return { success: false, error: "Missing fileId" };
    }

    const client = existingClient || getDatabaseClient(env);
    await ensureAnalyticsSchema(client);

    await client.execute({
      sql: `INSERT INTO file_stats (file_id, total_views, total_download_requests, updated_at)
            VALUES (?, 0, 0, ?)
            ON CONFLICT(file_id) DO NOTHING;`,
      args: [fileId, Date.now()],
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Analytics Lifecycle] Failed to init stats for file ${fileId}:`, message);
    return { success: false, error: message };
  }
}

/**
 * Cascades deletion of statistics records when a document is permanently deleted.
 * Cleans up file_stats and file_stats_daily.
 */
export async function cascadeDeleteFileStats(
  fileId: string,
  env?: DatabaseEnv,
  existingClient?: Client
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!fileId) {
      return { success: false, error: "Missing fileId" };
    }

    const client = existingClient || getDatabaseClient(env);
    await ensureAnalyticsSchema(client);

    // Atomically delete from file_stats and file_stats_daily
    await client.batch(
      [
        {
          sql: "DELETE FROM file_stats WHERE file_id = ?;",
          args: [fileId],
        },
        {
          sql: "DELETE FROM file_stats_daily WHERE file_id = ?;",
          args: [fileId],
        },
        {
          sql: "UPDATE documents SET is_deleted = 1, updated_at = ? WHERE id = ?;",
          args: [Date.now(), fileId],
        },
      ],
      "write"
    );

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Analytics Lifecycle] Failed to delete stats for file ${fileId}:`, message);
    return { success: false, error: message };
  }
}
