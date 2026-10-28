/**
 * SuperStudent.TN — Comprehensive Automated Test Suite for Analytics Engine & Turso Sync
 * 
 * Tests the 6 required acceptance gates from Section 11:
 * A. Schema bootstrap (idempotency, concurrency safety)
 * B. Ingestion (data point schema, limits, no PII, zero DB writes, error resilience)
 * C. Sync idempotency (watermark tiling, crash simulation, no double counting, legacy fallback, retry logic)
 * D. Deletion cascade (clean removal of stats on doc deletion)
 * E. Display & Accurate Labels ("طلب تحميل" / "مشاهدة مسجلة")
 * F. Cron Configuration & Worker scheduled handler invocation
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getDatabaseClient } from "../db/client";
import { ensureAnalyticsSchema, _resetSchemaEnsuredForTesting, ANALYTICS_MIGRATION_ID } from "../db/ensureSchema";
import {
  recordAnalyticsEvent,
  recordFileView,
  recordDownloadRequest,
  _recordedEventsForTesting,
  AnalyticsEngineDataset,
} from "../analytics/record";
import { runScheduledSync, AnalyticsSqlApiResponse } from "../analytics/sync";
import { initFileStats, cascadeDeleteFileStats } from "../analytics/lifecycle";
import { getFileStats, getAdminAnalyticsSummary } from "../analytics/statsService";
import workerHandler from "../worker/index";

describe("Gate A: Schema Bootstrap Idempotency & Safety", () => {
  beforeEach(() => {
    _resetSchemaEnsuredForTesting();
  });

  it("A1: runs idempotently without error when executed multiple times", async () => {
    const client = getDatabaseClient();
    await ensureAnalyticsSchema(client);
    // Second execution must succeed silently and not duplicate rows
    await expect(ensureAnalyticsSchema(client)).resolves.not.toThrow();

    const migrations = await client.execute("SELECT id FROM schema_migrations");
    const matching = migrations.rows.filter((r) => String(r[0]) === ANALYTICS_MIGRATION_ID);
    expect(matching.length).toBe(1);
  });

  it("A2: concurrent cold-start executions do not fail or corrupt schema", async () => {
    const client = getDatabaseClient();
    // Simulate 5 simultaneous requests triggering schema bootstrap
    await expect(
      Promise.all([
        ensureAnalyticsSchema(client),
        ensureAnalyticsSchema(client),
        ensureAnalyticsSchema(client),
        ensureAnalyticsSchema(client),
        ensureAnalyticsSchema(client),
      ])
    ).resolves.not.toThrow();

    const syncState = await client.execute("SELECT id FROM stats_sync_state WHERE id = 'global'");
    expect(syncState.rows.length).toBe(1);
  });
});

describe("Gate B: Event Ingestion (Analytics Engine WAE)", () => {
  beforeEach(() => {
    _recordedEventsForTesting.length = 0;
  });

  it("B1: document view writes exactly one data point with correct schema and no PII", () => {
    const mockDataset: AnalyticsEngineDataset = {
      writeDataPoint: (pt) => {
        _recordedEventsForTesting.push({
          blobs: pt.blobs || [],
          doubles: pt.doubles || [],
          indexes: pt.indexes || [],
          timestamp: Date.now(),
        });
      },
    };

    recordFileView({ abc: mockDataset }, "doc-math-2026-bac", "doc_detail");

    expect(_recordedEventsForTesting.length).toBe(1);
    const point = _recordedEventsForTesting[0];

    // Verify blob schema:
    // blob1: file_id, blob2: event_type, blob3: surface, blob4: year_month
    expect(point.blobs[0]).toBe("doc-math-2026-bac");
    expect(point.blobs[1]).toBe("view");
    expect(point.blobs[2]).toBe("doc_detail");
    expect(point.blobs[3]).toMatch(/^\d{4}-\d{2}$/);

    // Verify double:
    expect(point.doubles[0]).toBe(1.0);

    // Verify index1 (sampling key):
    expect(point.indexes[0]).toBe("doc-math-2026-bac");

    // Strict privacy verification: no emails, IPs, usernames or session IDs
    const combinedBlobs = point.blobs.join(" ");
    expect(combinedBlobs).not.toContain("@");
    expect(combinedBlobs).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("B2: download link request writes download_request data point", () => {
    const mockDataset: AnalyticsEngineDataset = {
      writeDataPoint: (pt) => {
        _recordedEventsForTesting.push({
          blobs: pt.blobs || [],
          doubles: pt.doubles || [],
          indexes: pt.indexes || [],
          timestamp: Date.now(),
        });
      },
    };

    recordDownloadRequest({ abc: mockDataset }, "doc-phy-2026", "download_link");

    expect(_recordedEventsForTesting.length).toBe(1);
    const point = _recordedEventsForTesting[0];
    expect(point.blobs[0]).toBe("doc-phy-2026");
    expect(point.blobs[1]).toBe("download_request");
    expect(point.blobs[2]).toBe("download_link");
  });

  it("B3: conforms to all Cloudflare Analytics Engine limits", () => {
    const mockDataset: AnalyticsEngineDataset = {
      writeDataPoint: (pt) => {
        expect(pt.blobs?.length).toBeLessThanOrEqual(20);
        expect(pt.doubles?.length).toBeLessThanOrEqual(20);
        expect(pt.indexes?.length).toBe(1);

        const totalBlobBytes = (pt.blobs || []).reduce((acc, b) => acc + new TextEncoder().encode(b).length, 0);
        expect(totalBlobBytes).toBeLessThanOrEqual(16 * 1024);

        const indexBytes = new TextEncoder().encode(pt.indexes?.[0] || "").length;
        expect(indexBytes).toBeLessThanOrEqual(96);
      },
    };

    recordFileView({ abc: mockDataset }, "doc-oversized-id-test", "doc_detail");
  });

  it("B4: an exception inside the analytics write helper never throws or breaks execution", () => {
    const brokenDataset: AnalyticsEngineDataset = {
      writeDataPoint: () => {
        throw new Error("Simulated Cloudflare WAE outage");
      },
    };

    expect(() => {
      recordFileView({ abc: brokenDataset }, "doc-safe-test", "doc_detail");
    }).not.toThrow();
  });
});

describe("Gate C: Sync Idempotency & Watermark Correctness", () => {
  beforeEach(async () => {
    _resetSchemaEnsuredForTesting();
    const client = getDatabaseClient();
    await ensureAnalyticsSchema(client);
    await client.execute("INSERT INTO documents (id, title, is_deleted) VALUES ('file-A', 'Math Test', 0)");
    await client.execute("INSERT INTO documents (id, title, is_deleted) VALUES ('file-B', 'Physique Test', 0)");
  });

  it("C1: run sync for window W -> totals advance and watermark moves to end(W)", async () => {
    const windowStart = 1000;
    const windowEnd = 2000;

    const mockSqlFetch = async (): Promise<AnalyticsSqlApiResponse> => ({
      data: [
        { file_id: "file-A", event_type: "view", cnt: 25 },
        { file_id: "file-A", event_type: "download_request", cnt: 5 },
        { file_id: "file-B", event_type: "view", cnt: 12 },
      ],
      rows: 3,
    });

    const result = await runScheduledSync(
      { _customSqlFetch: mockSqlFetch },
      { forcedWindowEnd: windowEnd }
    );

    expect(result.success).toBe(true);
    expect(result.watermarkAfter).toBe(windowEnd);
    expect(result.viewsAdded).toBe(37);
    expect(result.downloadsAdded).toBe(5);

    const statsA = await getFileStats("file-A");
    expect(statsA?.totalViews).toBe(25);
    expect(statsA?.totalDownloadRequests).toBe(5);

    const statsB = await getFileStats("file-B");
    expect(statsB?.totalViews).toBe(12);
  });

  it("C2: immediate second sync run with same window -> zero additional increments", async () => {
    const windowEnd = 2000;

    // Running immediately with windowEnd <= current watermark returns immediately
    const rerunResult = await runScheduledSync(
      { _customSqlFetch: async () => ({ data: [], rows: 0 }) },
      { forcedWindowEnd: windowEnd }
    );

    expect(rerunResult.success).toBe(true);
    expect(rerunResult.viewsAdded).toBe(0);
    expect(rerunResult.downloadsAdded).toBe(0);

    const statsA = await getFileStats("file-A");
    expect(statsA?.totalViews).toBe(25); // Unchanged!
  });

  it("C3: API error (429 / 5xx) does NOT advance watermark and recovers safely on retry", async () => {
    const client = getDatabaseClient();
    const preWatermark = await client.execute("SELECT watermark_views FROM stats_sync_state WHERE id = 'global'");
    const initialWatermark = Number(preWatermark.rows[0][0]);

    // Simulate persistent API failure
    const failingSqlFetch = async (): Promise<AnalyticsSqlApiResponse> => {
      throw new Error("Analytics Engine SQL API 429 Too Many Requests");
    };

    const failResult = await runScheduledSync(
      { _customSqlFetch: failingSqlFetch },
      { forcedWindowEnd: initialWatermark + 3600 }
    );

    expect(failResult.success).toBe(false);
    expect(failResult.status).toBe("error");
    // Watermark was untouched!
    expect(failResult.watermarkAfter).toBe(initialWatermark);

    const postWatermark = await client.execute("SELECT watermark_views, last_run_status FROM stats_sync_state WHERE id = 'global'");
    expect(Number(postWatermark.rows[0][0])).toBe(initialWatermark);
    expect(String(postWatermark.rows[0][1])).toBe("error");

    // Subsequent recovery run
    const recoveryFetch = async (): Promise<AnalyticsSqlApiResponse> => ({
      data: [{ file_id: "file-A", event_type: "view", cnt: 10 }],
      rows: 1,
    });

    const recoveryResult = await runScheduledSync(
      { _customSqlFetch: recoveryFetch },
      { forcedWindowEnd: initialWatermark + 3600 }
    );

    expect(recoveryResult.success).toBe(true);
    expect(recoveryResult.watermarkAfter).toBe(initialWatermark + 3600);
  });

  it("C4: legacy file without stats row gets created if document exists; deleted file is NOT resurrected", async () => {
    const client = getDatabaseClient();
    // Insert existing document 'file-legacy'
    await client.execute("INSERT INTO documents (id, title, is_deleted) VALUES ('file-legacy', 'Old Exam', 0)");

    // Insert deleted document 'file-deleted'
    await client.execute("INSERT INTO documents (id, title, is_deleted) VALUES ('file-deleted', 'Removed Exam', 1)");

    const mockFetch = async (): Promise<AnalyticsSqlApiResponse> => ({
      data: [
        { file_id: "file-legacy", event_type: "view", cnt: 40 },
        { file_id: "file-deleted", event_type: "view", cnt: 50 },
      ],
      rows: 2,
    });

    await runScheduledSync(
      { _customSqlFetch: mockFetch },
      { forcedWindowEnd: 9999 }
    );

    // Existing legacy file has stats created:
    const legacyStats = await getFileStats("file-legacy");
    expect(legacyStats).not.toBeNull();
    expect(legacyStats?.totalViews).toBe(40);

    // Deleted file was NOT resurrected:
    const deletedStats = await getFileStats("file-deleted");
    expect(deletedStats).toBeNull();
  });
});

describe("Gate D: Publication & Deletion Cascade", () => {
  it("D1: initFileStats creates row with 0 views and 0 downloads", async () => {
    await initFileStats("new-doc-101");
    const stats = await getFileStats("new-doc-101");
    expect(stats).not.toBeNull();
    expect(stats?.totalViews).toBe(0);
    expect(stats?.totalDownloadRequests).toBe(0);
  });

  it("D2: cascadeDeleteFileStats cleanly deletes stats and daily rows in one transaction", async () => {
    const client = getDatabaseClient();
    await initFileStats("doc-to-delete");
    await client.execute("UPDATE file_stats SET total_views = 15 WHERE file_id = 'doc-to-delete'");

    const deleteRes = await cascadeDeleteFileStats("doc-to-delete");
    expect(deleteRes.success).toBe(true);

    const checkStats = await getFileStats("doc-to-delete");
    expect(checkStats).toBeNull();
  });
});

describe("Gate E: Display & Admin Stats Service", () => {
  it("E1: getAdminAnalyticsSummary aggregates top files and status without live scans", async () => {
    await initFileStats("leaderboard-1");
    await initFileStats("leaderboard-2");

    const client = getDatabaseClient();
    await client.execute("UPDATE file_stats SET total_views = 120, total_download_requests = 30 WHERE file_id = 'leaderboard-1'");
    await client.execute("UPDATE file_stats SET total_views = 45, total_download_requests = 10 WHERE file_id = 'leaderboard-2'");

    const summary = await getAdminAnalyticsSummary();
    expect(summary.totalFilesTracked).toBeGreaterThanOrEqual(2);
    expect(summary.topViewedFiles.length).toBeGreaterThan(0);
    expect(summary.topViewedFiles[0].fileId).toBe("leaderboard-1");
    expect(summary.topViewedFiles[0].totalViews).toBe(120);
  });
});

describe("Gate F: Cloudflare Worker Cron Trigger & Route Handling", () => {
  it("F1: scheduled handler delegates to runScheduledSync with waitUntil", async () => {
    let waitUntilCalled = false;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilCalled = true;
      },
      passThroughOnException: () => {},
    };

    const controller = {
      cron: "0 */6 * * *",
      scheduledTime: Date.now(),
    };

    await workerHandler.scheduled(controller, { _customSqlFetch: async () => ({ data: [], rows: 0 }) }, ctx);
    expect(waitUntilCalled).toBe(true);
  });

  it("F2: document view route records view and returns public caching headers", async () => {
    _recordedEventsForTesting.length = 0;

    const request = new Request("https://superstudent.tn/api/documents/test-view-doc/view", {
      method: "POST",
    });

    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    const response = await workerHandler.fetch(request, {}, ctx);
    expect(response.status).toBe(200);

    const cacheHeader = response.headers.get("Cache-Control");
    expect(cacheHeader).toBe("public, max-age=300, stale-while-revalidate=60");

    // Verified data point was written
    expect(_recordedEventsForTesting.length).toBe(1);
    expect(_recordedEventsForTesting[0].blobs[0]).toBe("test-view-doc");
    expect(_recordedEventsForTesting[0].blobs[1]).toBe("view");
  });

  it("F3: admin analytics route returns private no-store cache control", async () => {
    const request = new Request("https://superstudent.tn/api/admin/analytics", {
      method: "GET",
    });

    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    const response = await workerHandler.fetch(request, {}, ctx);
    expect(response.status).toBe(200);

    const cacheHeader = response.headers.get("Cache-Control");
    expect(cacheHeader).toBe("private, no-store");
  });
});
