import { MESSAGE_RETENTION_MS } from "../constants";
import {
  Account,
  MessageItem,
  ChatMediaItem,
  StudentFeedbackItem,
  EliteApplicationItem,
  FaqItem,
  ComplaintReport,
  UserRole,
} from "../types";

export function normEmail(email: string): string {
  return (email || "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@'"/\\]+@[^\s@'"/\\]+\.[^\s@'"/\\]+$/.test(email);
}

export function isValidUsername(u: string): boolean {
  return /^[a-zA-Z0-9_\u0600-\u06FF-]{3,20}$/.test(u);
}

export function safeUsername(email: string): string {
  const base = normEmail(email).split("@")[0].replace(/[^a-zA-Z0-9_]/g, "").slice(0, 18) || "user";
  return base;
}

export async function resolveFileUrl(
  dataUrl: string,
  _fileName: string,
  _folder: "pdfs" | "images" | "avatars" = "images"
): Promise<string | null> {
  return dataUrl || null;
}

export async function uploadPDFToStorage(dataUrl: string, fileName: string, msgId: string): Promise<string | null> {
  return await resolveFileUrl(dataUrl, fileName, "pdfs");
}

export async function uploadChatImageToStorage(dataUrl: string, fileName: string): Promise<string> {
  const result = await resolveFileUrl(dataUrl, fileName, "images");
  return result || dataUrl;
}

export async function uploadAvatarToStorage(dataUrl: string, userUidOrUsername: string): Promise<string> {
  if (!dataUrl || !dataUrl.startsWith("data:")) return dataUrl;
  try {
    const resolvedUrl = await resolveFileUrl(dataUrl, `avatar_${userUidOrUsername}.jpg`, "avatars");
    return resolvedUrl || dataUrl;
  } catch {
    return dataUrl;
  }
}

export function resizeToDataURL(file: File, maxDim: number, quality: number, square: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (square) {
          const side = Math.min(sw, sh);
          sx = (sw - side) / 2; sy = (sh - side) / 2; sw = side; sh = side;
        }
        let outW = square ? maxDim : sw, outH = square ? maxDim : sh;
        if (!square) {
          if (sw > sh && sw > maxDim) { outH = Math.round(sh * (maxDim / sw)); outW = maxDim; }
          else if (sh > maxDim) { outW = Math.round(sw * (maxDim / sh)); outH = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas context unavailable"));
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Image load error"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("File read error"));
    reader.readAsDataURL(file);
  });
}

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error("File read error"));
    reader.readAsDataURL(file);
  });
}

export function formatTime(ts: number, lang: string): string {
  try {
    const locale = lang === "ar" ? "ar-TN" : lang === "fr" ? "fr-TN" : "en-US";
    return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  } catch {
    const d = new Date(ts);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

export function formatDateTime(ts: number, lang: string): string {
  try {
    const locale = lang === "ar" ? "ar-TN" : lang === "fr" ? "fr-TN" : "en-US";
    return new Date(ts).toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    const d = new Date(ts);
    return `${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

export interface DevApplicantFile {
  username: string;
  applicantRole: "student" | "professor";
  specialty?: string;
  discordUsername?: string;
  email: string;
  branch: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  uploadedPdfs: { id: string; title: string; url?: string; dataUrl?: string; uploadedAt: number }[];
}

export interface RoomSubscriptionHandlers {
  onMessage: (message: MessageItem) => void;
  onDelete: (messageId: string) => void;
  onMutes: (mutes: Record<string, number>) => void;
}

export function broadcastRoomEvent(
  roomId: string,
  event: "new_message" | "delete_message" | "update_message" | "room_mutes",
  payload: any
): void {
  try {
    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      const bc = new BroadcastChannel(`bac_channel_${roomId}`);
      bc.postMessage({ event, payload });
      bc.close();
    }
  } catch {}
}

export function subscribeToRoom(
  roomId: string,
  handlers: RoomSubscriptionHandlers
): () => void {
  let localBc: BroadcastChannel | null = null;
  try {
    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      localBc = new BroadcastChannel(`bac_channel_${roomId}`);
      localBc.onmessage = (e) => {
        const { event, payload } = e.data || {};
        if (event === "new_message" && payload) {
          handlers.onMessage(payload);
        } else if (event === "delete_message" && payload?.id) {
          handlers.onDelete(payload.id);
        } else if (event === "room_mutes" && payload) {
          handlers.onMutes(payload);
        }
      };
    }
  } catch {}

  return () => {
    if (localBc) {
      try {
        localBc.close();
      } catch {}
    }
  };
}

// -------------------------------------------------------------
// Admin & Moderation RPCs connected to Turso Worker Endpoints
// -------------------------------------------------------------

function getAuthHeader(): Record<string, string> {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("superstudent_session_token") || "" : "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchAdminUsers(filters?: { role?: string; status?: string; search?: string }): Promise<Account[]> {
  try {
    const params = new URLSearchParams();
    if (filters?.role) params.set("role", filters.role);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.search) params.set("search", filters.search);

    const res = await fetch(`/api/admin/users?${params.toString()}`, {
      headers: { ...getAuthHeader() },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.users)) {
        return data.users;
      }
    }
  } catch (err) {
    console.error("fetchAdminUsers failed:", err);
  }
  return [];
}

export async function banUserRPC(targetEmail: string, _durationMs: number | null): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function unbanUserRPC(targetEmail: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/unban`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function promoteToModeratorRPC(targetEmail: string, _roomIds: string[]): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ role: "moderator" }),
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function demoteModeratorRPC(targetEmail: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ role: "member" }),
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function promoteToSuperAdminRPC(targetEmail: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ role: "superadmin", canUpload: true }),
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function demoteSuperAdminRPC(targetEmail: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ role: "member" }),
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function setEliteStudentRPC(targetEmail: string, isElite: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ role: isElite ? "elite_student" : "member", canUpload: isElite }),
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function setUserCanUploadRPC(targetEmail: string, allowed: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ canUpload: allowed }),
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function deleteUserAccountRPC(targetEmail: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}`, {
      method: "DELETE",
      headers: { ...getAuthHeader() },
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data.success, error: data.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Student Feedbacks
export async function submitStudentFeedback(fb: StudentFeedbackItem): Promise<boolean> {
  try {
    const res = await fetch("/api/feedbacks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fb),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getStudentFeedbacks(): Promise<StudentFeedbackItem[]> {
  try {
    const res = await fetch("/api/admin/feedbacks", {
      headers: { ...getAuthHeader() },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.feedbacks)) return data.feedbacks;
    }
  } catch {}
  return [];
}

export async function deleteStudentFeedback(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/admin/feedbacks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { ...getAuthHeader() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function toggleResolveStudentFeedback(id: string, resolved?: boolean): Promise<boolean> {
  try {
    const res = await fetch(`/api/admin/feedbacks/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ resolved: !!resolved }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Elite Applications
export async function submitEliteApplication(app: EliteApplicationItem): Promise<boolean> {
  try {
    const res = await fetch("/api/elite-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(app),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getEliteApplications(): Promise<EliteApplicationItem[]> {
  try {
    const res = await fetch("/api/admin/elite-applications", {
      headers: { ...getAuthHeader() },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.applications)) return data.applications;
    }
  } catch {}
  return [];
}

export async function updateEliteApplicationStatus(
  id: string,
  status: "approved" | "rejected",
  _reviewedBy: string
): Promise<boolean> {
  try {
    const res = await fetch(`/api/admin/elite-applications/${encodeURIComponent(id)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveEliteApplicationRPC(appId: string, newStatus: "approved" | "rejected"): Promise<{ success: boolean; error?: string }> {
  const ok = await updateEliteApplicationStatus(appId, newStatus, "admin");
  return { success: ok };
}

export async function deleteEliteApplication(appId: string): Promise<boolean> {
  return true;
}

// Dynamic FAQs
export async function getDynamicFaqs(): Promise<FaqItem[]> {
  try {
    const res = await fetch("/api/faqs");
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.faqs)) return data.faqs;
    }
  } catch {}
  return [];
}

export async function saveDynamicFaq(faq: FaqItem): Promise<boolean> {
  try {
    const res = await fetch("/api/admin/faqs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify(faq),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteDynamicFaq(faqId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/admin/faqs/${encodeURIComponent(faqId)}`, {
      method: "DELETE",
      headers: { ...getAuthHeader() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Complaints
export async function submitComplaintReport(report: ComplaintReport): Promise<boolean> {
  return true;
}

export async function getComplaintReports(): Promise<ComplaintReport[]> {
  return [];
}

export async function deleteComplaintReport(_reportId: string): Promise<boolean> {
  return true;
}

// Key-Value fallback for local demo state
export async function getJSON<T = unknown>(key: string, _shared = false): Promise<T | null> {
  try {
    const val = localStorage.getItem(`ss_${key}`);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

export async function setJSON(key: string, value: unknown, _shared = false): Promise<boolean> {
  try {
    localStorage.setItem(`ss_${key}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export async function delKey(key: string, _shared = false): Promise<void> {
  try {
    localStorage.removeItem(`ss_${key}`);
  } catch {}
}

export async function listKeys(prefix: string, _shared = false): Promise<string[]> {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`ss_${prefix}`)) {
        keys.push(k.replace(/^ss_/, ""));
      }
    }
    return keys;
  } catch {
    return [];
  }
}

export async function pruneExpiredRoomMessages(_messagesKey: string, rawMessages: MessageItem[]): Promise<MessageItem[]> {
  const cutoff = Date.now() - MESSAGE_RETENTION_MS;
  return (rawMessages || []).filter((m) => m.createdAt && m.createdAt >= cutoff);
}

export async function fetchRoomMessages(_roomId: string): Promise<MessageItem[]> {
  return [];
}

export async function saveRoomMessage(roomId: string, message: MessageItem): Promise<boolean> {
  broadcastRoomEvent(roomId, "new_message", message);
  return true;
}

export async function deleteRoomMessage(roomId: string, messageId: string): Promise<boolean> {
  broadcastRoomEvent(roomId, "delete_message", { id: messageId });
  return true;
}

export async function fetchRoomMutes(_roomId: string): Promise<Record<string, number>> {
  return {};
}

export async function saveRoomMutes(roomId: string, mutes: Record<string, number>): Promise<boolean> {
  broadcastRoomEvent(roomId, "room_mutes", mutes);
  return true;
}

export async function recordChatMedia(_items: ChatMediaItem[]): Promise<void> {}

export async function getChatMediaVault(): Promise<ChatMediaItem[]> {
  return [];
}

export async function purgeExpiredMediaVault(): Promise<{ purgedCount: number; remainingCount: number }> {
  return { purgedCount: 0, remainingCount: 0 };
}

export async function deleteChatMediaItem(_id: string): Promise<boolean> {
  return true;
}

export async function getDevApplicantFile(_username: string): Promise<DevApplicantFile | null> {
  return null;
}

export async function deleteDevApplicantFile(_username: string): Promise<boolean> {
  return true;
}

export async function getAccountByEmail(email: string): Promise<Account | null> {
  return null;
}

export async function getAccountByUsername(username: string): Promise<Account | null> {
  return null;
}

export async function getAccountByAccessCode(_code: string): Promise<Account | null> {
  return null;
}

export async function saveAccount(_account: Account): Promise<boolean> {
  return true;
}
