import { describe, it, expect, beforeEach } from "vitest";
import worker from "../worker/index";
import { getDatabaseClient } from "../db/client";
import { ensureAnalyticsSchema } from "../db/ensureSchema";

describe("2026 Cloudflare Worker Cache Policy & Endpoints Verification", () => {
  const dummyCtx: any = {
    waitUntil: (p: Promise<any>) => p.catch(() => {}),
    passThroughOnException: () => {},
  };

  const dummyEnv: any = {
    OWNER_EMAIL: "learningmyj20@gmail.com",
    SETUP_SECRET: "SUPERSTUDENT_SECURE_SETUP_2026",
    abc: {
      writeDataPoint: () => {},
    },
  };

  beforeEach(async () => {
    const client = getDatabaseClient(dummyEnv);
    await ensureAnalyticsSchema(client);
  });

  it("returns 600s max-age (10min) with stale-while-revalidate and ETag for public documents", async () => {
    const req = new Request("https://superstudent.tn/api/documents", { method: "GET" });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);

    expect(res.status).toBe(200);
    const cacheHeader = res.headers.get("Cache-Control") || "";
    expect(cacheHeader).toContain("public");
    expect(cacheHeader).toContain("max-age=600");
    expect(cacheHeader).toContain("stale-while-revalidate=60");

    const etag = res.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Revalidation with If-None-Match returns HTTP 304 Not Modified
    const req304 = new Request("https://superstudent.tn/api/documents", {
      method: "GET",
      headers: { "If-None-Match": etag! },
    });
    const res304 = await worker.fetch(req304, dummyEnv, dummyCtx);
    expect(res304.status).toBe(304);
  });

  it("returns 180s max-age (3min) with stale-while-revalidate and ETag for announcements", async () => {
    const req = new Request("https://superstudent.tn/api/announcements", { method: "GET" });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);

    expect(res.status).toBe(200);
    const cacheHeader = res.headers.get("Cache-Control") || "";
    expect(cacheHeader).toContain("public");
    expect(cacheHeader).toContain("max-age=180");
    expect(cacheHeader).toContain("stale-while-revalidate=60");

    const etag = res.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Revalidation with If-None-Match returns HTTP 304 Not Modified
    const req304 = new Request("https://superstudent.tn/api/announcements", {
      method: "GET",
      headers: { "If-None-Match": etag! },
    });
    const res304 = await worker.fetch(req304, dummyEnv, dummyCtx);
    expect(res304.status).toBe(304);
  });

  it("returns 60s max-age with stale-while-revalidate for public settings", async () => {
    const req = new Request("https://superstudent.tn/api/settings/public", { method: "GET" });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);

    expect(res.status).toBe(200);
    const cacheHeader = res.headers.get("Cache-Control") || "";
    expect(cacheHeader).toContain("public");
    expect(cacheHeader).toContain("max-age=60");
    expect(cacheHeader).toContain("stale-while-revalidate=30");
  });

  it("handles download request via 302 redirect without proxying bytes through Worker", async () => {
    const client = getDatabaseClient(dummyEnv);
    await client.execute({
      sql: "INSERT INTO documents (id, title, subject_id, branch_ids, doc_type, file_url, is_deleted, created_at, updated_at) VALUES ('doc_test_download', 'Test Doc', 'math', 'math', 'exam', 'https://catbox.moe/test.pdf', 0, 100, 100)",
      args: [],
    });

    const req = new Request("https://superstudent.tn/api/documents/doc_test_download/download", {
      method: "GET",
    });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://catbox.moe/test.pdf");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});
