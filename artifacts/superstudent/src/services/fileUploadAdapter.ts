/**
 * SuperStudent.TN — File Upload Adapter & Multi-Provider Fallback Service
 * Supports:
 * 1. Primary Provider: Catbox (https://catbox.moe/user/api.php)
 * 2. Fallback Provider: Buzzheavier (https://buzzheavier.com/api/upload)
 * 3. Client-side Base64 Data URL fallback for sandbox/offline
 * 4. MIME type validation (SVG strictly rejected, PDFs and common images allowed)
 * 5. Size limits: Live class / Exams up to 25MB, avatars/chat up to 10MB
 */

export interface UploadOptions {
  folder?: "documents" | "live_class" | "avatars" | "chat";
  maxSizeMB?: number;
  allowedTypes?: string[];
}

export interface UploadResult {
  success: boolean;
  url?: string;
  provider?: "catbox" | "buzzheavier" | "inline";
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  error?: string;
}

const FORBIDDEN_EXTENSIONS = [
  ".svg", ".exe", ".sh", ".bat", ".cmd", ".vbs", ".js", ".html", ".htm", ".php"
];

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function validateFileBeforeUpload(
  file: File,
  options: UploadOptions = {}
): { valid: boolean; error?: string } {
  const maxSizeMB = options.maxSizeMB || (options.folder === "live_class" || options.folder === "documents" ? 25 : 10);
  const maxBytes = maxSizeMB * 1024 * 1024;

  if (file.size > maxBytes) {
    return {
      valid: false,
      error: `حجم الملف (${(file.size / (1024 * 1024)).toFixed(1)}MB) يتجاوز الحد الأقصى المسموح به (${maxSizeMB}MB).`,
    };
  }

  const nameLower = file.name.toLowerCase();
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (nameLower.endsWith(ext)) {
      return {
        valid: false,
        error: `نوع الملف غير مسموح به لأسباب أمنية (${ext}). يُسمح فقط بملفات PDF والصور.`,
      };
    }
  }

  if (options.allowedTypes && options.allowedTypes.length > 0) {
    if (!options.allowedTypes.includes(file.type)) {
      return {
        valid: false,
        error: `نوع الملف (${file.type || "غير معروف"}) غير مطابق للأنواع المسموحة (${options.allowedTypes.join(", ")}).`,
      };
    }
  } else if (!ALLOWED_MIME_TYPES.has(file.type)) {
    if (file.type === "" && nameLower.endsWith(".pdf")) {
      // allow PDF without explicit MIME header
    } else {
      return {
        valid: false,
        error: `نوع الملف (${file.type || "غير مدعوم"}) غير مصرح به. يُسمح فقط بملفات PDF والصور المعتمدة.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Uploads file to Catbox with Buzzheavier and local inline fallback.
 */
export async function uploadFile(
  file: File,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const validation = validateFileBeforeUpload(file, options);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // 1. Primary Provider: Catbox.moe
  try {
    const formData = new FormData();
    formData.append("reqtype", "fileupload");
    formData.append("fileToUpload", file);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const res = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const url = (await res.text()).trim();
      if (url.startsWith("http")) {
        return {
          success: true,
          url,
          provider: "catbox",
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/pdf",
        };
      }
    }
  } catch (err) {
    console.warn("[Upload Adapter] Catbox failed or blocked, attempting Buzzheavier fallback:", err);
  }

  // 2. Secondary Provider: Buzzheavier
  try {
    const formData = new FormData();
    formData.append("file", file);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const res = await fetch("https://buzzheavier.com/api/upload", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json() as any;
      const buzzUrl = data.url || data.link || (data.id ? `https://buzzheavier.com/f/${data.id}` : null);
      if (buzzUrl && buzzUrl.startsWith("http")) {
        return {
          success: true,
          url: buzzUrl,
          provider: "buzzheavier",
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/pdf",
        };
      }
    }
  } catch (err) {
    console.warn("[Upload Adapter] Buzzheavier failed, falling back to client data URL:", err);
  }

  // 3. Fallback: Base64 Data URL (safe resilient storage for local/demo)
  try {
    const dataUrl = await fileToDataUrl(file);
    return {
      success: true,
      url: dataUrl,
      provider: "inline",
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || "application/pdf",
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "فشل قراءة الملف وتحميله.",
    };
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("فشل تحويل الملف إلى رابط بيانات."));
    reader.readAsDataURL(file);
  });
}
