import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SYNC_GRANT_SECRET_ENV = 'NARSIL_SYNC_GRANT_SECRET'
export const SYNC_GRANT_LIFETIME_ENV = 'NARSIL_SYNC_GRANT_MS'
export const DEFAULT_SYNC_GRANT_LIFETIME_MS = 15 * 60 * 1000
export const MIN_SYNC_GRANT_LIFETIME_MS = 1_000
export const MAX_SYNC_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000
export const SYNC_SUBPROTOCOL = 'narsil.sync.v1'

export function offeredFeedCredential(protocolHeader: string | undefined): { credential: string | undefined } | null {
  if (protocolHeader === undefined) return null
  const values = protocolHeader.split(',').map(value => value.trim())
  if (values[0] !== SYNC_SUBPROTOCOL || values.length > 2) return null
  return { credential: values[1] }
}

const SYNC_GRANT_VERSION = 'v1'
const SYNC_GRANT_SECRET_BYTES = 32
const SYNC_GRANT_NONCE_BYTES = 16
const MIN_SYNC_GRANT_SECRET_LENGTH = 32
const MAX_SYNC_GRANT_LENGTH = 1_024
const SYNC_GRANT_PARTS = 5

export interface SyncGrant {
  credential: string
  expiresAt: number
}

export function createSyncGrantSecret(): string {
  return randomBytes(SYNC_GRANT_SECRET_BYTES).toString('base64url')
}

export function syncGrantSecretFromEnv(env: NodeJS.ProcessEnv): string | null {
  const secret = env[SYNC_GRANT_SECRET_ENV]
  if (secret === undefined || secret.length < MIN_SYNC_GRANT_SECRET_LENGTH) return null
  return secret
}

export function syncGrantLifetimeFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[SYNC_GRANT_LIFETIME_ENV]
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_SYNC_GRANT_LIFETIME_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_SYNC_GRANT_LIFETIME_MS || value > MAX_SYNC_GRANT_LIFETIME_MS) {
    throw new Error(
      `${SYNC_GRANT_LIFETIME_ENV} must be a whole number of milliseconds from ${MIN_SYNC_GRANT_LIFETIME_MS} to ${MAX_SYNC_GRANT_LIFETIME_MS}, got "${raw}"`,
    )
  }
  return value
}

function signature(secret: string, indexName: string, expiresAt: number, nonce: string): Buffer {
  return createHmac('sha256', secret).update(`${SYNC_GRANT_VERSION}\n${indexName}\n${expiresAt}\n${nonce}`).digest()
}

export function mintSyncGrant(secret: string, indexName: string, lifetimeMs: number, now: number): SyncGrant {
  const expiresAt = now + lifetimeMs
  const nonce = randomBytes(SYNC_GRANT_NONCE_BYTES).toString('base64url')
  const mac = signature(secret, indexName, expiresAt, nonce).toString('base64url')
  const encodedIndex = Buffer.from(indexName, 'utf-8').toString('base64url')
  return { credential: [SYNC_GRANT_VERSION, encodedIndex, String(expiresAt), nonce, mac].join('.'), expiresAt }
}

export function verifySyncGrant(secret: string, credential: string, indexName: string, now: number): number | null {
  if (credential.length > MAX_SYNC_GRANT_LENGTH) return null
  const parts = credential.split('.')
  if (parts.length !== SYNC_GRANT_PARTS) return null
  const [version, encodedIndex, rawExpiresAt, nonce, mac] = parts
  if (
    version !== SYNC_GRANT_VERSION ||
    encodedIndex === undefined ||
    rawExpiresAt === undefined ||
    nonce === undefined ||
    mac === undefined ||
    !/^\d{1,16}$/.test(rawExpiresAt)
  ) {
    return null
  }
  const expiresAt = Number(rawExpiresAt)
  const grantedIndex = Buffer.from(encodedIndex, 'base64url').toString('utf-8')
  const expected = Buffer.from(signature(secret, grantedIndex, expiresAt, nonce).toString('base64url'))
  const presented = Buffer.from(mac)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  if (grantedIndex !== indexName || expiresAt <= now) return null
  return expiresAt
}
