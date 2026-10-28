/**
 * SuperStudent.TN — Asynchronous Private Telegram Backup Service
 * Specifications:
 * 1. Backs up eligible PDF documents to a private Telegram channel/chat.
 * 2. Runs asynchronously (via ctx.waitUntil in Worker, or fire-and-forget).
 * 3. Never exposes bot tokens, private channel IDs, or Telegram URLs to the public frontend.
 * 4. Telegram is strictly a private archival backup, never a public CDN.
 */

export interface TelegramBackupPayload {
  fileUrl: string;
  fileName: string;
  title: string;
  docId: string;
  author?: string;
  fileBytes?: ArrayBuffer | Uint8Array;
}

export interface TelegramBackupEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export async function backupPdfToTelegram(
  payload: TelegramBackupPayload,
  env?: TelegramBackupEnv
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  const botToken =
    env?.TELEGRAM_BOT_TOKEN ||
    (typeof process !== "undefined" ? process.env?.TELEGRAM_BOT_TOKEN : undefined) ||
    "";
  const chatId =
    env?.TELEGRAM_CHAT_ID ||
    (typeof process !== "undefined" ? process.env?.TELEGRAM_CHAT_ID : undefined) ||
    "";

  if (!botToken || !chatId) {
    // Silent safe bypass when Telegram credentials are not yet configured in environment
    console.log("[Telegram Backup] Skipping: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured.");
    return { success: false, error: "CREDENTIALS_NOT_SET" };
  }

  const caption = `📄 SuperStudent.TN — Backup Archive\n• Title: ${payload.title}\n• Doc ID: ${payload.docId}\n• File: ${payload.fileName}\n• Author: ${payload.author || "N/A"}\n• Time: ${new Date().toISOString()}`;

  try {
    const telegramEndpoint = `https://api.telegram.org/bot${botToken}/sendDocument`;

    // Case 1: Send via URL if public HTTPS URL
    if (payload.fileUrl && payload.fileUrl.startsWith("https://")) {
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append("document", payload.fileUrl);
      formData.append("caption", caption);

      const res = await fetch(telegramEndpoint, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const data = await res.json() as any;
        console.log(`[Telegram Backup] Successfully backed up docId=${payload.docId} to Telegram chat.`);
        return { success: true, messageId: data.result?.message_id };
      }
    }

    // Case 2: Send raw binary bytes if provided (e.g. dataUrl or buffer)
    if (payload.fileBytes) {
      const formData = new FormData();
      formData.append("chat_id", chatId);
      const blob = new Blob([payload.fileBytes as any], { type: "application/pdf" });
      formData.append("document", blob, payload.fileName || "document.pdf");
      formData.append("caption", caption);

      const res = await fetch(telegramEndpoint, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const data = await res.json() as any;
        return { success: true, messageId: data.result?.message_id };
      }
    }

    return { success: false, error: "Telegram API upload failed" };
  } catch (err: any) {
    console.error("[Telegram Backup] Non-fatal backup failure:", err.message);
    return { success: false, error: err.message };
  }
}
