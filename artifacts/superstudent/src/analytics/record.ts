/**
 * SuperStudent.TN — Analytics Engine Event Ingestion Helper
 * Writes Cloudflare Workers Analytics Engine (WAE) data points.
 * 
 * Binding name: 'abc'
 * Dataset name: 'SuperStudent'
 * 
 * Rules:
 * - NO Turso database write on view/download
 * - Fire-and-forget: wrapped in try/catch, never fails caller response
 * - Zero PII: only file_id, event_type, surface, and year_month_bucket
 * - Stays comfortably within all Cloudflare limits:
 *     Blobs: 4/20 (<16KB)
 *     Doubles: 1/20
 *     Indexes: 1/1 (<=96 bytes)
 */

export type AnalyticsEventType = "view" | "download_request";
export type AnalyticsSurface = "doc_detail" | "download_link" | "announcement_attachment";

export interface AnalyticsEngineDataset {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface WorkerEnvWithAnalytics {
  abc?: AnalyticsEngineDataset; // Owner's approved binding
  [key: string]: unknown;
}

export interface RecordAnalyticsParams {
  env?: WorkerEnvWithAnalytics;
  fileId: string;
  eventType: AnalyticsEventType;
  surface?: AnalyticsSurface;
  timestamp?: number;
}

/**
 * Global in-memory buffer used in test environments or when running outside Cloudflare Workers.
 */
export const _recordedEventsForTesting: Array<{
  blobs: string[];
  doubles: number[];
  indexes: string[];
  timestamp: number;
}> = [];

/**
 * Record an analytics event to Cloudflare Workers Analytics Engine.
 * Must NEVER throw, NEVER block user response, and NEVER write to Turso.
 */
export function recordAnalyticsEvent({
  env,
  fileId,
  eventType,
  surface = "doc_detail",
  timestamp = Date.now(),
}: RecordAnalyticsParams): void {
  try {
    if (!fileId || typeof fileId !== "string") {
      return;
    }

    // Sanitize and bound file_id to respect Cloudflare index limits (max 96 bytes)
    const cleanFileId = fileId.trim().slice(0, 96);
    if (!cleanFileId) return;

    // UTC Year-Month string (e.g., "2026-10")
    const dateObj = new Date(timestamp);
    const yearMonth = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, "0")}`;

    // Schema Layout:
    // blob1 = file_id
    // blob2 = event_type ("view" | "download_request")
    // blob3 = surface ("doc_detail" | "download_link" | "announcement_attachment")
    // blob4 = year_month_bucket ("YYYY-MM")
    // double1 = 1.0 (for SUM(_sample_interval * double1))
    // index1 = file_id (sampling key)
    const dataPoint = {
      blobs: [cleanFileId, eventType, surface, yearMonth],
      doubles: [1.0],
      indexes: [cleanFileId],
    };

    // If running inside Cloudflare Worker with 'abc' binding attached:
    if (env?.abc && typeof env.abc.writeDataPoint === "function") {
      env.abc.writeDataPoint(dataPoint);
    } else {
      // In local dev/test fallback, capture in test array
      _recordedEventsForTesting.push({
        ...dataPoint,
        timestamp,
      });
    }
  } catch (err) {
    // Non-blocking: Silently handle analytics engine write failure so user request is never interrupted
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "development") {
      console.warn("[Analytics Engine] Non-fatal write failure:", err);
    }
  }
}

/**
 * Helper to record a file view event.
 * Supports both (env, fileId, surface) in Workers and (fileId, surface) in client calls.
 */
export function recordFileView(
  envOrFileId?: WorkerEnvWithAnalytics | string,
  fileIdOrSurface?: string | AnalyticsSurface,
  surfaceOpt: AnalyticsSurface = "doc_detail"
): void {
  const isEnvFirst = typeof envOrFileId === "object" && envOrFileId !== null;
  const env = isEnvFirst ? (envOrFileId as WorkerEnvWithAnalytics) : undefined;
  const fileId = isEnvFirst ? String(fileIdOrSurface || "") : String(envOrFileId || "");
  const surface = isEnvFirst ? surfaceOpt : ((fileIdOrSurface as AnalyticsSurface) || "doc_detail");

  recordAnalyticsEvent({
    env,
    fileId,
    eventType: "view",
    surface,
  });
}

/**
 * Helper to record a download request event.
 * Supports both (env, fileId, surface) in Workers and (fileId, surface) in client calls.
 */
export function recordDownloadRequest(
  envOrFileId?: WorkerEnvWithAnalytics | string,
  fileIdOrSurface?: string | AnalyticsSurface,
  surfaceOpt: AnalyticsSurface = "download_link"
): void {
  const isEnvFirst = typeof envOrFileId === "object" && envOrFileId !== null;
  const env = isEnvFirst ? (envOrFileId as WorkerEnvWithAnalytics) : undefined;
  const fileId = isEnvFirst ? String(fileIdOrSurface || "") : String(envOrFileId || "");
  const surface = isEnvFirst ? surfaceOpt : ((fileIdOrSurface as AnalyticsSurface) || "download_link");

  recordAnalyticsEvent({
    env,
    fileId,
    eventType: "download_request",
    surface,
  });
}
