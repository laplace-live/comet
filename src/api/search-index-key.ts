import { randomBytes } from 'node:crypto'

// Minimal shape of Electron's safeStorage, so this module is testable in plain Node.
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

// Persistence backend for the wrapped key blob (production: a file in userData).
export interface KeyStoreIO {
  read(key: string): string | null
  write(key: string, value: string): void
}

const STORE_KEY = 'comet-index-key'
const TAG_ENCRYPTED = 'v1:'
const TAG_PLAIN = 'v0:'

/**
 * Generate a fresh 32-byte raw key as 64 lowercase hex chars.
 * Fed to SQLCipher via PRAGMA key = "x'<hex>'".
 */
export function generateKeyHex(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Wrap a key hex for at-rest persistence.
 * Uses safeStorage when available (tagged v1); otherwise falls back to plain
 * base64 (tagged v0) and the caller is expected to surface a degraded-mode warning.
 */
export function wrapKey(keyHex: string, safe: SafeStorageLike): string {
  if (safe.isEncryptionAvailable()) {
    const blob = safe.encryptString(keyHex).toString('base64')
    return TAG_ENCRYPTED + blob
  }
  return TAG_PLAIN + Buffer.from(keyHex, 'utf-8').toString('base64')
}

/**
 * Reverse wrapKey. Throws if a v1 blob cannot be decrypted by this backend
 * (e.g. machine/keychain changed) so the caller can offer rebuild.
 */
export function unwrapKey(wrapped: string, safe: SafeStorageLike): string {
  if (wrapped.startsWith(TAG_ENCRYPTED)) {
    const blob = wrapped.slice(TAG_ENCRYPTED.length)
    return safe.decryptString(Buffer.from(blob, 'base64'))
  }
  if (wrapped.startsWith(TAG_PLAIN)) {
    const blob = wrapped.slice(TAG_PLAIN.length)
    return Buffer.from(blob, 'base64').toString('utf-8')
  }
  throw new Error('unwrapKey: unrecognized wrapped-key format')
}

/**
 * Read the persisted wrapped key and unwrap it; if none exists (first run),
 * generate a fresh key, wrap, persist, and return it. Stable across calls.
 */
export function resolveKeyHex(safe: SafeStorageLike, io: KeyStoreIO): string {
  const existing = io.read(STORE_KEY)
  if (existing) {
    return unwrapKey(existing, safe)
  }
  const hex = generateKeyHex()
  io.write(STORE_KEY, wrapKey(hex, safe))
  return hex
}
