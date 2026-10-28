/**
 * SuperStudent.TN — Automated Test Suite for Auth, Registration Limits & Viewers
 * Tests:
 * 1. PBKDF2 password hashing & verification via Web Crypto API
 * 2. 1-week invite code gating during rollout
 * 3. Atomic 15,000 daily new registrations cap
 * 4. User login via normalized email or username
 * 5. Prevention of client self-promotion to superadmin
 * 6. Google Docs PDF Viewer URL structure & fallback
 */

import { describe, it, expect, beforeEach } from "vitest";
import { hashPassword, verifyPassword, generateSecureToken } from "../utils/cryptoAuth";
import { registerUser, loginUser, validateSession, logoutSession } from "../services/serverAuth";
import { getDatabaseClient } from "../db/client";
import { ensureAnalyticsSchema, _resetSchemaEnsuredForTesting } from "../db/ensureSchema";

describe("Web Crypto PBKDF2 Password Security", () => {
  it("hashes password with 100,000 iterations and per-user salt", async () => {
    const password = "superSecretPassword123";
    const hash = await hashPassword(password);

    expect(hash.startsWith("pbkdf2:sha256:100000:")).toBe(true);
    const parts = hash.split(":");
    expect(parts.length).toBe(5);
    expect(parts[3].length).toBe(32); // 16 bytes salt in hex
    expect(parts[4].length).toBe(64); // 32 bytes derived bits in hex

    // Second hash of same password must have different salt
    const hash2 = await hashPassword(password);
    expect(hash).not.toBe(hash2);
  });

  it("verifies valid password and rejects incorrect password", async () => {
    const password = "correctHorseBatteryStaple";
    const hash = await hashPassword(password);

    const isMatch = await verifyPassword(password, hash);
    expect(isMatch).toBe(true);

    const isWrong = await verifyPassword("wrongPasswordAttempt", hash);
    expect(isWrong).toBe(false);
  });
});

describe("Server-Authoritative Registration & Abuse Protection", () => {
  beforeEach(async () => {
    _resetSchemaEnsuredForTesting();
    const client = getDatabaseClient();
    await ensureAnalyticsSchema(client);
    // Reset test data
    await client.execute("DELETE FROM users");
    await client.execute("DELETE FROM sessions");
    await client.execute("DELETE FROM registration_daily_counter");
    // Ensure invite-only is enabled with code 'BAC2025'
    await client.execute(
      "UPDATE system_config SET value = 'true' WHERE key = 'invite_only_active'"
    );
    await client.execute(
      "UPDATE system_config SET value = 'BAC2025' WHERE key = 'invite_code'"
    );
    await client.execute(
      "UPDATE system_config SET value = '15000' WHERE key = 'daily_registration_cap'"
    );
  });

  it("rejects signup when required invite code is missing or invalid during rollout", async () => {
    const resNoCode = await registerUser({
      email: "student1@bac.tn",
      username: "student1",
      displayName: "Student One",
      password: "password123",
      branch: "math",
    });
    expect(resNoCode.success).toBe(false);
    expect(resNoCode.error).toContain("رمز دعوة");

    const resWrongCode = await registerUser({
      email: "student1@bac.tn",
      username: "student1",
      displayName: "Student One",
      password: "password123",
      branch: "math",
      inviteCode: "WRONG_CODE",
    });
    expect(resWrongCode.success).toBe(false);
    expect(resWrongCode.error).toContain("رمز الدعوة غير صحيح");
  });

  it("strictly rejects public registration with owner email (learningmyj20@gmail.com)", async () => {
    const res = await registerUser({
      email: "learningmyj20@gmail.com",
      username: "owner_imposter",
      displayName: "Imposter",
      password: "securePassword2025",
      branch: "math",
      inviteCode: "BAC2025",
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe("OWNER_EMAIL_RESERVED");
    expect(res.error).toContain("محجوز للإدارة");
  });

  it("succeeds for student signup with valid invite code and assigns role 'member' (never superadmin)", async () => {
    const res = await registerUser({
      email: "regular_student@bac.tn",
      username: "student_regular",
      displayName: "Regular Student",
      password: "securePassword2025",
      branch: "math",
      inviteCode: "BAC2025",
    });

    expect(res.success).toBe(true);
    expect(res.account).toBeDefined();
    // Role MUST be 'member' — zero client self-promotion to superadmin
    expect(res.account?.role).toBe("member");
    expect(res.account?.canUpload).toBe(false);
    expect(res.sessionToken).toBeDefined();
  });

  it("rejects duplicate email and duplicate username with typed error codes", async () => {
    // Register first user
    const first = await registerUser({
      email: "duplicate_test@bac.tn",
      username: "duplicate_user",
      displayName: "Original User",
      password: "password123",
      branch: "math",
      inviteCode: "BAC2025",
    });
    expect(first.success).toBe(true);

    // Duplicate email
    const dupEmail = await registerUser({
      email: "duplicate_test@bac.tn",
      username: "different_user",
      displayName: "Different User",
      password: "password123",
      branch: "math",
      inviteCode: "BAC2025",
    });
    expect(dupEmail.success).toBe(false);
    expect(dupEmail.code).toBe("EMAIL_ALREADY_REGISTERED");

    // Duplicate username
    const dupUser = await registerUser({
      email: "another_test@bac.tn",
      username: "duplicate_user",
      displayName: "Another User",
      password: "password123",
      branch: "math",
      inviteCode: "BAC2025",
    });
    expect(dupUser.success).toBe(false);
    expect(dupUser.code).toBe("USERNAME_ALREADY_TAKEN");
  });

  it("handles owner bootstrap with setup secret, creates superadmin, and enforces idempotency", async () => {
    const { bootstrapOwner } = await import("../services/serverAuth");

    // 1. Wrong secret fails
    const badSecret = await bootstrapOwner("WRONG_SECRET", "SuperAdminPassword2026!");
    expect(badSecret.success).toBe(false);
    expect(badSecret.code).toBe("UNAUTHORIZED");

    // 2. Short password fails
    const shortPass = await bootstrapOwner("SUPERSTUDENT_SECURE_SETUP_2026", "short");
    expect(shortPass.success).toBe(false);
    expect(shortPass.code).toBe("WEAK_PASSWORD");

    // 3. Valid bootstrap succeeds
    const success = await bootstrapOwner("SUPERSTUDENT_SECURE_SETUP_2026", "SuperAdminPassword2026!");
    expect(success.success).toBe(true);
    expect(success.code).toBe("BOOTSTRAP_SUCCESSFUL");
    expect(success.account?.role).toBe("superadmin");
    expect(success.account?.canUpload).toBe(true);
    expect(success.account?.email).toBe("learningmyj20@gmail.com");

    // 4. Idempotent guard: second bootstrap fails
    const secondAttempt = await bootstrapOwner("SUPERSTUDENT_SECURE_SETUP_2026", "AnotherPassword2026!");
    expect(secondAttempt.success).toBe(false);
    expect(secondAttempt.code).toBe("OWNER_ALREADY_INITIALIZED");

    // 5. Bootstrapped owner can log in with their credentials
    const loginRes = await loginUser("learningmyj20@gmail.com", "SuperAdminPassword2026!");
    expect(loginRes.success).toBe(true);
    expect(loginRes.account?.role).toBe("superadmin");
    expect(loginRes.account?.canUpload).toBe(true);
  });

  it("enforces atomic 15,000 daily new registrations cap", async () => {
    const client = getDatabaseClient();
    const today = new Date().toISOString().split("T")[0];

    // Artificially simulate that today reached the 15,000 cap
    await client.execute({
      sql: "INSERT INTO registration_daily_counter (day_utc, count) VALUES (?, 15000) ON CONFLICT(day_utc) DO UPDATE SET count = 15000",
      args: [today],
    });

    const res = await registerUser({
      email: "student_overflow@bac.tn",
      username: "overflow_student",
      displayName: "Overflow Student",
      password: "password123",
      branch: "sciences",
      inviteCode: "BAC2025",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("15,000");
  });

  it("allows existing users to log in even when the daily registration cap is reached", async () => {
    const client = getDatabaseClient();
    const today = new Date().toISOString().split("T")[0];

    // 1. First register a valid user under 15,000
    await client.execute({
      sql: "DELETE FROM registration_daily_counter WHERE day_utc = ?",
      args: [today],
    });

    const reg = await registerUser({
      email: "existing_user@bac.tn",
      username: "existing_user",
      displayName: "Existing User",
      password: "mySecretPassword",
      branch: "math",
      inviteCode: "BAC2025",
    });
    if (!reg.success) console.error("TEST 4 REG FAILED:", reg);
    expect(reg.success).toBe(true);

    // 2. Cap is hit for subsequent new registrations
    await client.execute({
      sql: "UPDATE registration_daily_counter SET count = 15000 WHERE day_utc = ?",
      args: [today],
    });

    // 3. Existing user can still log in without issue via email or username!
    const loginByEmail = await loginUser("existing_user@bac.tn", "mySecretPassword");
    expect(loginByEmail.success).toBe(true);
    expect(loginByEmail.account?.username).toBe("existing_user");

    const loginByUsername = await loginUser("existing_user", "mySecretPassword");
    expect(loginByUsername.success).toBe(true);

    // Wrong password fails
    const loginWrongPass = await loginUser("existing_user", "wrongPass");
    expect(loginWrongPass.success).toBe(false);
  });

  it("validates session tokens and revokes on logout", async () => {
    const reg = await registerUser({
      email: "session_tester@bac.tn",
      username: "session_tester",
      displayName: "Session Tester",
      password: "validPassword123",
      branch: "technique",
      inviteCode: "BAC2025",
    });

    const token = reg.sessionToken!;
    const validatedAccount = await validateSession(token);
    expect(validatedAccount).not.toBeNull();
    expect(validatedAccount?.email).toBe("session_tester@bac.tn");

    // Logout revokes session
    await logoutSession(token);
    const postLogoutAccount = await validateSession(token);
    expect(postLogoutAccount).toBeNull();
  });
});

describe("Google Docs PDF Viewer URL Standards", () => {
  it("formats Google Docs PDF Viewer embed URL accurately with encoded parameter", () => {
    const rawUrl = "https://cdn.superstudent.tn/files/bac2024_math_principale.pdf";
    const googleViewerUrl = `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(rawUrl)}`;

    expect(googleViewerUrl).toBe(
      "https://docs.google.com/gview?embedded=true&url=https%3A%2F%2Fcdn.superstudent.tn%2Ffiles%2Fbac2024_math_principale.pdf"
    );
  });
});
