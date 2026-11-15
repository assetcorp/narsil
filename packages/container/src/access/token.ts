import { createHmac, timingSafeEqual } from 'node:crypto'
import { MAX_TOKEN_BYTES, MAX_TOKEN_INDEXES, NOT_BEFORE_LEEWAY_SECONDS, SHA256_BYTES } from './constants'

export type Role = 'admin' | 'read'

export interface VerifiedToken {
  role: Role
  expiresAtSeconds: number
  indexes: ReadonlySet<string> | null
  subject: string | undefined
  group: string | undefined
}

export interface SigningKeys {
  admin: Buffer | null
  read: Buffer | null
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

function decodeSegment(segment: string): Buffer | null {
  if (!BASE64URL.test(segment)) return null
  const bytes = Buffer.from(segment, 'base64url')
  return bytes.toString('base64url') === segment ? bytes : null
}

function parseObject(bytes: Buffer): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function signatureMatches(key: Buffer | null, signingInput: string, signature: Buffer): boolean {
  if (key === null) return false
  const expected = createHmac('sha256', key).update(signingInput, 'ascii').digest()
  return timingSafeEqual(expected, signature)
}

function roleOf(keys: SigningKeys, signingInput: string, signature: Buffer): Role | null {
  const admin = signatureMatches(keys.admin, signingInput, signature)
  const read = signatureMatches(keys.read, signingInput, signature)
  if (admin) return 'admin'
  return read ? 'read' : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function indexesOf(value: unknown): ReadonlySet<string> | null | undefined {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length > MAX_TOKEN_INDEXES) return undefined
  if (!value.every(item => typeof item === 'string')) return undefined
  return new Set(value as string[])
}

export function verifyToken(token: string, keys: SigningKeys, nowMs: number): VerifiedToken | null {
  if (token.length > MAX_TOKEN_BYTES) return null
  const segments = token.split('.')
  if (segments.length !== 3) return null
  const [encodedHeader, encodedPayload, encodedSignature] = segments
  const headerBytes = decodeSegment(encodedHeader)
  const payloadBytes = decodeSegment(encodedPayload)
  const signature = decodeSegment(encodedSignature)
  if (headerBytes === null || payloadBytes === null || signature === null) return null
  if (signature.length !== SHA256_BYTES) return null
  const header = parseObject(headerBytes)
  if (header === null || header.alg !== 'HS256' || header.crit !== undefined) return null
  const role = roleOf(keys, `${encodedHeader}.${encodedPayload}`, signature)
  if (role === null) return null
  const payload = parseObject(payloadBytes)
  if (payload === null) return null
  const nowSeconds = nowMs / 1000
  const { exp, nbf } = payload
  if (!isFiniteNumber(exp) || !Number.isFinite(exp * 1000) || exp <= nowSeconds) return null
  if (nbf !== undefined && (!isFiniteNumber(nbf) || nbf > nowSeconds + NOT_BEFORE_LEEWAY_SECONDS)) return null
  const indexes = indexesOf(payload.indexes)
  const subject = optionalText(payload.sub)
  const group = optionalText(payload.group)
  if (indexes === undefined || subject === null || group === null) return null
  return { role, expiresAtSeconds: exp, indexes, subject, group }
}
