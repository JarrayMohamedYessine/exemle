import { Account, HomepageAnnouncement, LangKey, SuperAnnouncement, AnnouncementType, UserRole } from "../types";

export function isUserOwner(user: Account | null): boolean {
  if (!user) return false;
  return user.role === "superadmin" || user.email.toLowerCase() === "learningmyj20@gmail.com";
}

export function isUserTeacher(user: Account | null): boolean {
  if (!user) return false;
  return user.role === "teacher";
}

export function isUserEliteStudent(user: Account | null): boolean {
  if (!user) return false;
  return user.role === "elite_student";
}

export function canUserCreateAnnouncementType(user: Account | null, type: AnnouncementType): boolean {
  if (!user) return false;
  if (isUserOwner(user) || isUserTeacher(user)) {
    return true;
  }
  if (isUserEliteStudent(user)) {
    return type === "tip";
  }
  return false;
}

export function canUserPublishAnyAnnouncement(user: Account | null): boolean {
  if (!user) return false;
  return isUserOwner(user) || isUserTeacher(user) || isUserEliteStudent(user);
}

export function getAvailableAnnouncementTypesForUser(user: Account | null): AnnouncementType[] {
  if (!user) return [];
  if (isUserOwner(user) || isUserTeacher(user)) {
    return ["live_class", "alert", "announcement", "tip"];
  }
  if (isUserEliteStudent(user)) {
    return ["tip"];
  }
  return [];
}

export function canUserEditAnnouncement(user: Account | null, announcement: SuperAnnouncement): boolean {
  if (!user) return false;
  if (isUserOwner(user)) return true;
  if (user.username && user.username === announcement.authorUsername) return true;
  if (user.email && announcement.authorEmail && user.email.toLowerCase() === announcement.authorEmail.toLowerCase()) return true;
  return false;
}

export function canUserDeleteAnnouncement(user: Account | null, announcement: SuperAnnouncement): boolean {
  if (!user) return false;
  if (isUserOwner(user)) return true;
  if (user.username && user.username === announcement.authorUsername) return true;
  if (user.email && announcement.authorEmail && user.email.toLowerCase() === announcement.authorEmail.toLowerCase()) return true;
  return false;
}

let localSuperAnnouncementsCache: SuperAnnouncement[] = [];

export async function getAllSuperAnnouncements(): Promise<SuperAnnouncement[]> {
  try {
    const res = await fetch("/api/announcements");
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.announcements)) {
        const transformed: SuperAnnouncement[] = data.announcements.map((a: any) => ({
          id: a.id,
          type: a.type as AnnouncementType,
          title: a.title,
          content: a.content,
          targetBranches: a.targetBranches,
          isPinned: a.isPinned,
          authorId: a.authorId,
          authorUsername: a.authorUsername || "admin",
          authorDisplayName: a.authorDisplayName || "الإدارة التربوية",
          authorRole: "teacher",
          fileUrl: a.type === "live_class" ? a.fileUrl : undefined,
          corrigeUrl: a.type === "live_class" ? a.corrigeUrl : undefined,
          pdfAttachments: a.type === "live_class" && a.fileUrl ? [{ id: "att-1", name: "مرفق الحصة المباشرة.pdf", url: a.fileUrl }] : [],
          correctionPdfs: a.type === "live_class" && a.corrigeUrl ? [{ id: "corr-1", name: "ملف الإصلاح النموذجي.pdf", url: a.corrigeUrl }] : [],
          createdAt: a.createdAt,
        }));
        localSuperAnnouncementsCache = transformed;
        return transformed;
      }
    }
  } catch {}
  return localSuperAnnouncementsCache;
}

export interface CreateSuperAnnouncementInput {
  type: AnnouncementType;
  title?: string;
  content: string;
  subjectId?: string;
  targetBranches?: string[];
  isAllBranches?: boolean;
  date?: string;
  startTime?: string;
  endTime?: string;
  platform?: string;
  customPlatformName?: string;
  joinUrl?: string;
  pdfAttachmentUrl?: string;
  pdfAttachmentName?: string;
  pdfAttachmentSize?: string;
  pdfAttachments?: { id: string; name: string; size?: string; url?: string; dataUrl?: string }[];
  correctionPdfs?: { id: string; name: string; size?: string; url?: string; dataUrl?: string }[];
}

export async function publishSuperAnnouncement(
  input: CreateSuperAnnouncementInput,
  user: Account
): Promise<{ success: boolean; announcement?: SuperAnnouncement; error?: string }> {
  try {
    const token = localStorage.getItem("superstudent_session_token") || "";
    // Enforce attachment constraint: only live_class may have attachments!
    const fileUrl = input.type === "live_class" ? (input.pdfAttachmentUrl || input.pdfAttachments?.[0]?.url || input.pdfAttachments?.[0]?.dataUrl) : null;

    const res = await fetch("/api/announcements", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : "",
      },
      body: JSON.stringify({
        title: input.title,
        content: input.content,
        type: input.type,
        targetBranches: input.targetBranches,
        fileUrl,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.announcement) {
        const ann: SuperAnnouncement = {
          ...data.announcement,
          authorUsername: user.username,
          authorDisplayName: user.displayName,
          authorRole: user.role,
        };
        localSuperAnnouncementsCache = [ann, ...localSuperAnnouncementsCache];
        return { success: true, announcement: ann };
      }
      return { success: false, error: data.error };
    }
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err.error || "تعذر نشر الإعلان." };
  } catch (err: any) {
    return { success: false, error: err.message || "خطأ أثناء الاتصال بالخادم." };
  }
}

export async function updateSuperAnnouncement(
  id: string,
  input: Partial<CreateSuperAnnouncementInput>,
  user: Account
): Promise<{ success: boolean; announcement?: SuperAnnouncement; error?: string }> {
  try {
    const token = localStorage.getItem("superstudent_session_token") || "";
    // Note: Correction PDFs are only permitted for live_class in edit mode
    const fileUrl = input.pdfAttachmentUrl || input.pdfAttachments?.[0]?.url || input.pdfAttachments?.[0]?.dataUrl;
    const corrigeUrl = input.correctionPdfs?.[0]?.url || input.correctionPdfs?.[0]?.dataUrl;

    const res = await fetch(`/api/announcements/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : "",
      },
      body: JSON.stringify({
        title: input.title,
        content: input.content,
        fileUrl,
        corrigeUrl,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        localSuperAnnouncementsCache = localSuperAnnouncementsCache.map((a) =>
          a.id === id
            ? {
                ...a,
                title: input.title || a.title,
                content: input.content || a.content,
                fileUrl: fileUrl || a.fileUrl,
                corrigeUrl: corrigeUrl || a.corrigeUrl,
              }
            : a
        );
        return { success: true };
      }
      return { success: false, error: data.error };
    }
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err.error || "تعذر تحديث الإعلان." };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function deleteSuperAnnouncement(
  id: string,
  user: Account
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = localStorage.getItem("superstudent_session_token") || "";
    const res = await fetch(`/api/announcements/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: token ? `Bearer ${token}` : "",
      },
    });

    if (res.ok) {
      localSuperAnnouncementsCache = localSuperAnnouncementsCache.filter((a) => a.id !== id);
      return { success: true };
    }
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err.error || "تعذر حذف الإعلان." };
  } catch {
    localSuperAnnouncementsCache = localSuperAnnouncementsCache.filter((a) => a.id !== id);
    return { success: true };
  }
}

export async function getAllAnnouncements(): Promise<HomepageAnnouncement[]> {
  return [];
}

export async function getActiveAnnouncementForUser(
  user: Account | null
): Promise<HomepageAnnouncement | null> {
  return null;
}

export async function createAnnouncement(
  data: Omit<HomepageAnnouncement, "id" | "createdAt" | "expiresAt" | "isActive">,
  authorEmail: string
): Promise<{ success: boolean; announcement?: HomepageAnnouncement; error?: string }> {
  return { success: true };
}

export async function deleteAnnouncement(id: string): Promise<boolean> {
  return true;
}

export async function toggleAnnouncementActive(id: string, active: boolean): Promise<boolean> {
  return true;
}

export function dismissAnnouncementPermanently(announcementId: string) {
  return;
}
