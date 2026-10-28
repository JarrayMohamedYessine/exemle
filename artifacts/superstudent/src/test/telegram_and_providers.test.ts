import { describe, it, expect } from "vitest";
import { validateFileBeforeUpload } from "../services/fileUploadAdapter";
import { backupPdfToTelegram } from "../services/telegramBackup";

describe("File Upload Validation & Security Gates", () => {
  it("strictly rejects executable and SVG files to prevent XSS", () => {
    const fakeSvg = new File(["<svg></svg>"], "malicious.svg", { type: "image/svg+xml" });
    const resSvg = validateFileBeforeUpload(fakeSvg);
    expect(resSvg.valid).toBe(false);
    expect(resSvg.error).toContain("غير مسموح به لأسباب أمنية");

    const fakeExe = new File(["MZ..."], "script.exe", { type: "application/x-msdownload" });
    const resExe = validateFileBeforeUpload(fakeExe);
    expect(resExe.valid).toBe(false);
    expect(resExe.error).toContain("غير مسموح به لأسباب أمنية");
  });

  it("strictly enforces 25MB maximum size on live class and document PDFs", () => {
    // 26 MB fake file
    const oversized = {
      name: "huge_exam.pdf",
      size: 26 * 1024 * 1024,
      type: "application/pdf",
    } as File;

    const res = validateFileBeforeUpload(oversized, { folder: "documents", maxSizeMB: 25 });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("يتجاوز الحد الأقصى");
  });

  it("accepts valid PDF within 25MB limit", () => {
    const validPdf = {
      name: "Bac_Math_2026.pdf",
      size: 3 * 1024 * 1024,
      type: "application/pdf",
    } as File;

    const res = validateFileBeforeUpload(validPdf, { folder: "documents", maxSizeMB: 25 });
    expect(res.valid).toBe(true);
  });
});

describe("Asynchronous Private Telegram PDF Backup", () => {
  it("safely bypasses execution without throwing when credentials are not configured", async () => {
    const res = await backupPdfToTelegram({
      fileUrl: "https://catbox.moe/example.pdf",
      fileName: "test.pdf",
      title: "Test Exam",
      docId: "doc_123",
      author: "Test Author",
    }, { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" });

    expect(res.success).toBe(false);
    expect(res.error).toBe("CREDENTIALS_NOT_SET");
  });

  it("handles non-fatal network failures without disrupting execution", async () => {
    const res = await backupPdfToTelegram({
      fileUrl: "https://catbox.moe/example.pdf",
      fileName: "test.pdf",
      title: "Test Exam",
      docId: "doc_123",
      author: "Test Author",
    }, { TELEGRAM_BOT_TOKEN: "fake_token_123", TELEGRAM_CHAT_ID: "-10012345678" });

    // Should return clean failure object, never throw unhandled exception
    expect(typeof res.success).toBe("boolean");
  });
});
