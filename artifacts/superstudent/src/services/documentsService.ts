import { BacDocumentItem, Account } from "../types";
import { canUserPublishDocuments } from "../constants";
import { createNotification } from "./notificationService";
import { initFileStats, cascadeDeleteFileStats } from "../analytics/lifecycle";
import { recordFileView, recordDownloadRequest } from "../analytics/record";
import { generateNativePdfBlob, openInGooglePdfViewer, base64ToPdfBlobUrl } from "../utils/pdfNativeHelper";

export interface DocumentFilters {
  branch?: string;
  subject?: string;
  docType?: string;
  search?: string;
  cursor?: number;
  limit?: number;
}

// In-memory cache for fast local retrieval
let cachedDocuments: BacDocumentItem[] = [];

export async function getDeletedDocIds(): Promise<string[]> {
  try {
    const raw = localStorage.getItem("superstudent_deleted_docs");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function getAllBacDocuments(filters?: DocumentFilters): Promise<BacDocumentItem[]> {
  try {
    const params = new URLSearchParams();
    if (filters?.branch) params.set("branch", filters.branch);
    if (filters?.subject) params.set("subject", filters.subject);
    if (filters?.docType) params.set("docType", filters.docType);
    if (filters?.search) params.set("q", filters.search);
    if (filters?.cursor) params.set("cursor", String(filters.cursor));
    if (filters?.limit) params.set("limit", String(filters.limit));

    const res = await fetch(`/api/documents?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.documents)) {
        cachedDocuments = data.documents;
        return data.documents;
      }
    }
  } catch {
    // Network fallback: return cached or empty
  }

  return cachedDocuments;
}

export function ensureRealPdfDataUrls(doc: BacDocumentItem): BacDocumentItem {
  let pdfDataUrl = doc.pdfDataUrl || doc.pdfUrl;
  let corrigePdfDataUrl = doc.corrigePdfDataUrl || doc.corrigePdfUrl;

  if (!pdfDataUrl) {
    pdfDataUrl = resolveNativePdfUrl(doc, false);
  }
  if (!corrigePdfDataUrl && doc.hasCorrige) {
    corrigePdfDataUrl = resolveNativePdfUrl(doc, true);
  }

  return {
    ...doc,
    pdfDataUrl,
    corrigePdfDataUrl,
  };
}

export async function publishBacDocument(
  doc: Omit<BacDocumentItem, "id" | "createdAt" | "downloadCount">,
  user: Account
): Promise<{ success: boolean; error?: string; document?: BacDocumentItem }> {
  try {
    const token = localStorage.getItem("superstudent_session_token") || "";
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : "",
      },
      body: JSON.stringify({
        title: doc.title,
        subjectId: doc.subjectId,
        branchIds: doc.branchIds,
        docType: doc.type,
        fileUrl: doc.pdfDataUrl || doc.pdfUrl,
        corrigeUrl: doc.corrigePdfDataUrl || doc.corrigePdfUrl,
        authorDisplayName: user.displayName || user.username,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.document) {
        cachedDocuments = [data.document, ...cachedDocuments];
        return { success: true, document: data.document };
      }
      return { success: false, error: data.error || "فشل نشر الوثيقة." };
    }
    const errData = await res.json().catch(() => ({}));
    return { success: false, error: errData.error || "خطأ في خادم النشر." };
  } catch (err: any) {
    // Safe local creation fallback
    const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newDoc: BacDocumentItem = {
      ...doc,
      id: docId,
      createdAt: Date.now(),
      downloadCount: 0,
      authorDisplayName: user.displayName,
      authorUsername: user.username,
    };
    cachedDocuments = [newDoc, ...cachedDocuments];
    await initFileStats(docId);
    return { success: true, document: newDoc };
  }
}

export async function deleteBacDocument(
  docId: string,
  user?: Account | null
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = localStorage.getItem("superstudent_session_token") || "";
    const res = await fetch(`/api/documents/${docId}`, {
      method: "DELETE",
      headers: {
        Authorization: token ? `Bearer ${token}` : "",
      },
    });

    if (res.ok) {
      cachedDocuments = cachedDocuments.filter((d) => d.id !== docId);
      return { success: true };
    }
  } catch {
    // Safe fallback
  }

  cachedDocuments = cachedDocuments.filter((d) => d.id !== docId);
  await cascadeDeleteFileStats(docId);
  return { success: true };
}

export async function purgeDocumentsByUsername(username: string): Promise<number> {
  const initialLen = cachedDocuments.length;
  cachedDocuments = cachedDocuments.filter((d) => d.authorUsername !== username);
  return initialLen - cachedDocuments.length;
}

export async function incrementDocDownload(docId: string): Promise<void> {
  recordDownloadRequest(docId, "download_link");
  try {
    fetch(`/api/documents/${docId}/download`, { method: "POST" }).catch(() => {});
  } catch {}
}

export async function getBookmarkedDocIds(): Promise<string[]> {
  try {
    const raw = localStorage.getItem("superstudent_bookmarked_docs");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function toggleDocBookmark(docId: string): Promise<string[]> {
  try {
    const current = await getBookmarkedDocIds();
    const next = current.includes(docId)
      ? current.filter((id) => id !== docId)
      : [...current, docId];
    localStorage.setItem("superstudent_bookmarked_docs", JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

export function downloadDocumentFile(doc: BacDocumentItem): void {
  // Fire-and-forget measurement point to Cloudflare Analytics Engine (no database write on download)
  recordDownloadRequest(doc.id, "download_link");
  try {
    fetch(`/api/documents/${doc.id}/download`, { method: "POST" }).catch(() => {});
  } catch {}

  if (doc.pdfDataUrl) {
    const a = document.createElement("a");
    a.href = doc.pdfDataUrl;
    a.download = doc.examFileName || `SuperStudent_${doc.title.replace(/[/\\?%*:|"<>]/g, "_")}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  if (doc.pdfUrl) {
    window.open(doc.pdfUrl, "_blank");
    return;
  }

  const blob = generateNativePdfBlob({
    title: doc.title,
    subtitle: `${doc.type?.toUpperCase()} - ${doc.trimestre?.toUpperCase()}`,
    subject: doc.subjectId,
    section: doc.branchIds?.join(", "),
    year: doc.year || 2026,
    author: doc.authorDisplayName || doc.authorName || doc.authorUsername,
    content: doc.contentSnippet || "محتوى الوثيقة قيد التحديث والتدقيق التربوي.",
    isCorrige: false,
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.examFileName || `SuperStudent_${doc.title.replace(/[/\\?%*:|"<>]/g, "_")}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function downloadCorrigeFile(doc: BacDocumentItem): void {
  // Fire-and-forget measurement point to Cloudflare Analytics Engine (no database write on download)
  recordDownloadRequest(doc.id, "download_link");
  try {
    fetch(`/api/documents/${doc.id}/download`, { method: "POST" }).catch(() => {});
  } catch {}

  if (doc.corrigePdfDataUrl) {
    const a = document.createElement("a");
    a.href = doc.corrigePdfDataUrl;
    a.download = doc.corrigeFileName || `SuperStudent_${doc.title.replace(/[/\\?%*:|"<>]/g, "_")}_Corrige.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  if (doc.corrigePdfUrl) {
    window.open(doc.corrigePdfUrl, "_blank");
    return;
  }

  const blob = generateNativePdfBlob({
    title: doc.title,
    subtitle: "الإصلاح النموذجي والسلّم المعتمد",
    subject: doc.subjectId,
    section: doc.branchIds?.join(", "),
    year: doc.year || 2026,
    author: doc.authorDisplayName || doc.authorName || doc.authorUsername,
    content: doc.contentSnippet || "الإصلاح النموذجي متوفر ومطابق للبرنامج الرسمي.",
    isCorrige: true,
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.corrigeFileName || `SuperStudent_${doc.title.replace(/[/\\?%*:|"<>]/g, "_")}_Corrige.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function downloadBothDocumentFiles(doc: BacDocumentItem): void {
  downloadDocumentFile(doc);
  if (doc.corrigePdfDataUrl || doc.corrigePdfUrl) {
    setTimeout(() => {
      downloadCorrigeFile(doc);
    }, 300);
  }
}

export async function getBacDocumentById(id: string): Promise<BacDocumentItem | null> {
  try {
    const res = await fetch(`/api/documents/${id}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.document) return data.document;
    }
  } catch {}
  return cachedDocuments.find((d) => d.id === id) || null;
}

export function resolveNativePdfUrl(doc: BacDocumentItem, isCorrige = false): string {
  const rawUrl = isCorrige
    ? (doc.corrigePdfDataUrl || doc.corrigePdfUrl)
    : (doc.pdfDataUrl || doc.pdfUrl);

  if (rawUrl) {
    if (rawUrl.startsWith("data:application/pdf;base64,")) {
      return base64ToPdfBlobUrl(rawUrl);
    }
    return rawUrl;
  }

  const blob = generateNativePdfBlob({
    title: doc.title,
    subtitle: isCorrige ? "Correction officielle & Barème de notation" : `${doc.type?.toUpperCase()} - ${doc.trimestre?.toUpperCase()}`,
    subject: doc.subjectId,
    section: doc.branchIds?.join(", "),
    year: doc.year || 2026,
    author: doc.authorDisplayName || doc.authorName || doc.authorUsername,
    content: doc.contentSnippet || "Contenu du document en cours de numérisation.",
    isCorrige,
  });

  return URL.createObjectURL(blob);
}

export function openBacDocumentNativePdf(
  doc: BacDocumentItem,
  isCorrige = false,
  e?: React.MouseEvent
): void {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  // Fire-and-forget measurement point to Cloudflare Analytics Engine (no database write on view)
  recordFileView(doc.id, "doc_detail");
  try {
    fetch(`/api/documents/${doc.id}/view`, { method: "POST" }).catch(() => {});
  } catch {}

  const url = resolveNativePdfUrl(doc, isCorrige);
  openInGooglePdfViewer(url, doc.title);
}

export function resolveDirectViewUrl(
  pdfUrl?: string | null,
  pdfDataUrl?: string | null
): string {
  const activeUrl = pdfDataUrl || pdfUrl;
  if (!activeUrl) return "#";
  if (activeUrl.startsWith("data:application/pdf;base64,")) {
    return base64ToPdfBlobUrl(activeUrl);
  }
  return activeUrl;
}
