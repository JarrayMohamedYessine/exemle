/**
 * SuperStudent.TN — Secure Authentication Cryptography
 * Uses the standard Web Crypto API (supported natively in Cloudflare Workers, modern browsers, and Node 18+).
 * Implements PBKDF2 with SHA-256 and 100,000 iterations for password hashing.
 * Constant-time comparison prevents timing attacks.
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/**
 * Converts a Uint8Array buffer to a lowercase hexadecimal string.
 */
function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Converts a hexadecimal string to a Uint8Array.
 */
function hexToBuffer(hex: string): Uint8Array {
  const cleanHex = hex.trim();
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Constant-time byte array comparison to prevent timing attacks.
 */
function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Hashes a plaintext password using PBKDF2-SHA256 with 100,000 iterations.
 * Returns formatted string: pbkdf2:sha256:100000:<salt_hex>:<hash_hex>
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string");
  }

  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);

  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    HASH_BYTES * 8
  );

  const saltHex = bufferToHex(salt);
  const hashHex = bufferToHex(derivedBits);

  return `pbkdf2:sha256:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

/**
 * Verifies a plaintext password against a stored PBKDF2 hash.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash) return false;

  const parts = storedHash.split(":");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") {
    return false;
  }

  const iterations = parseInt(parts[2], 10);
  const salt = hexToBuffer(parts[3]);
  const expectedHash = hexToBuffer(parts[4]);

  if (isNaN(iterations) || iterations < 10000 || salt.length !== SALT_BYTES) {
    return false;
  }

  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: iterations,
      hash: "SHA-256",
    },
    passwordKey,
    expectedHash.length * 8
  );

  const actualHash = new Uint8Array(derivedBits);
  return constantTimeEquals(actualHash, expectedHash);
}

/**
 * Generates a cryptographically secure random hexadecimal token (for session IDs).
 */
export function generateSecureToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bufferToHex(buffer);
}
