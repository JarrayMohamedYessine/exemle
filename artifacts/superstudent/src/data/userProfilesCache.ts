import { Account, UserRole } from "../types";

export interface CachedUserProfile {
  email: string;
  username: string;
  displayName: string;
  branch: string;
  gradeLevel: string;
  role: UserRole;
  avatar?: string | null;
  createdAt: number;
  canUpload?: boolean;
  banned?: boolean;
  moderatorRooms?: string[];
  lastActiveAt?: number;
}

export function getLocalUserProfile(_identifier?: string | null): CachedUserProfile | null {
  return null;
}

export function saveUserProfileToLocalCache(
  account: Partial<Account> & { email: string; username: string; displayName: string }
): CachedUserProfile {
  const username = account.username.trim().toLowerCase();
  return {
    email: account.email.trim().toLowerCase(),
    username,
    displayName: account.displayName.trim() || username,
    branch: account.branch || "math",
    gradeLevel: account.gradeLevel || "4eme_bac",
    role: account.role || "member",
    avatar: account.avatar ?? null,
    createdAt: account.createdAt || Date.now(),
    canUpload: account.canUpload || false,
    banned: account.banned || false,
    moderatorRooms: account.moderatorRooms || [],
    lastActiveAt: Date.now(),
  };
}

export function evictUserProfileCache(_identifier?: string | null): boolean {
  return false;
}

export function getAllLocalUserProfiles(): CachedUserProfile[] {
  return [];
}

export function formatUserDisplayName(identifierOrAccount?: Account | string | null): string {
  if (!identifierOrAccount) return "مستخدم المساق";
  if (typeof identifierOrAccount === "object") {
    return identifierOrAccount.displayName || identifierOrAccount.username || "مستخدم المساق";
  }
  return identifierOrAccount;
}

export function getUserAvatarUrl(identifierOrAccount?: Account | string | null): string | null {
  if (!identifierOrAccount || typeof identifierOrAccount !== "object") return null;
  return identifierOrAccount.avatar || null;
}
