/**
 * SuperStudent.TN — Client Auth & Session Bridge
 * Connects frontend auth actions to the server-authoritative authentication engine.
 * Never stores passwords, password hashes, or sensitive tokens in localStorage or IndexedDB.
 */

import { Account, UserRole } from "../types";
import { registerUser, loginUser, validateSession, logoutSession } from "./serverAuth";

let activeSessionToken: string | null = null;
let currentAccount: Account | null = null;

export function getActiveSessionToken(): string | null {
  if (activeSessionToken) return activeSessionToken;
  try {
    return sessionStorage.getItem("sst_stok");
  } catch {
    return null;
  }
}

export function setActiveSessionToken(token: string | null): void {
  activeSessionToken = token;
  try {
    if (token) {
      sessionStorage.setItem("sst_stok", token);
    } else {
      sessionStorage.removeItem("sst_stok");
    }
  } catch {}
}

export function getCurrentAccount(): Account | null {
  return currentAccount;
}

export function setCurrentAccount(acc: Account | null): void {
  currentAccount = acc;
}

/**
 * Executes user registration against the server backend with:
 * - PBKDF2 password hashing
 * - Daily 15,000 new registrations cap
 * - 1-week invite code verification
 * - Safe role assignment (no client self-promotion)
 */
export async function executeAuthSignup(payload: {
  displayName: string;
  username: string;
  email: string;
  branch: string;
  password: string;
  inviteCode?: string;
}): Promise<Account> {
  const result = await registerUser({
    displayName: payload.displayName,
    username: payload.username,
    email: payload.email,
    branch: payload.branch,
    password: payload.password,
    inviteCode: payload.inviteCode,
  });

  if (!result.success || !result.account) {
    throw new Error(result.error || "تعذر إتمام التسجيل.");
  }

  if (result.sessionToken) {
    setActiveSessionToken(result.sessionToken);
  }
  setCurrentAccount(result.account);
  return result.account;
}

/**
 * Executes user login against the server backend.
 */
export async function executeAuthLogin(
  identifier: string,
  passwordAttempt: string
): Promise<Account> {
  const result = await loginUser(identifier, passwordAttempt);
  if (!result.success || !result.account) {
    throw new Error(result.error || "تعذر تسجيل الدخول.");
  }

  if (result.sessionToken) {
    setActiveSessionToken(result.sessionToken);
  }
  setCurrentAccount(result.account);
  return result.account;
}

/**
 * Restores session from current session token.
 */
export async function restoreSession(): Promise<Account | null> {
  const token = getActiveSessionToken();
  if (!token) return null;

  const account = await validateSession(token);
  if (account) {
    setCurrentAccount(account);
    return account;
  } else {
    setActiveSessionToken(null);
    setCurrentAccount(null);
    return null;
  }
}

/**
 * Logs out and revokes server session.
 */
export async function executeAuthLogout(): Promise<void> {
  const token = getActiveSessionToken();
  if (token) {
    await logoutSession(token);
  }
  setActiveSessionToken(null);
  setCurrentAccount(null);
}

// Deprecated stubs preserved for legacy call compatibility without storing secrets
export function getAllCachedCredentials(): any[] { return []; }
export function saveCredentialToCache(_record: any): any { return null; }
export function findCachedCredential(_id: string): any { return null; }
export function verifyCachedCredentials(_id: string, _pass: string): any { return null; }
export function deleteCachedCredential(_email: string): boolean { return true; }
export function clearAllAuthCache(): void {}
export function setCachedSession(_account: Account): void {}
export function getCachedSession(): Account | null { return currentAccount; }
export function clearCachedSession(): void { executeAuthLogout().catch(() => {}); }
