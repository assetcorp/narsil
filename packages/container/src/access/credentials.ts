import { createHash, timingSafeEqual } from 'node:crypto'
import type { RequestContext } from '@delali/narsil/server'
import type { AccessKeys } from '../settings/types'
import { FEED_SUBPROTOCOLS } from './constants'
import { type Role, type SigningKeys, type VerifiedToken, verifyToken } from './token'

const BEARER = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i

export type Credential = { kind: 'key'; role: Role } | { kind: 'token'; role: Role; token: VerifiedToken }

interface KeyDigest {
  role: Role
  digest: Buffer
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function presentedValue(ctx: RequestContext): string | null {
  const authorization = ctx.headers.authorization
  if (authorization !== undefined) {
    const match = BEARER.exec(authorization)
    return match === null ? null : match[1]
  }
  const offered = ctx.headers['sec-websocket-protocol']
  if (offered === undefined || ctx.method !== 'GET') return null
  const protocols = offered.split(',').map(item => item.trim())
  const position = protocols.findIndex(protocol => FEED_SUBPROTOCOLS.includes(protocol))
  if (position === -1) return null
  const value = protocols[position + 1]
  return value === undefined || value.length === 0 ? null : value
}

export interface CredentialVerifier {
  verify(ctx: RequestContext): Credential | null
}

export function createCredentialVerifier(keys: AccessKeys, now: () => number = Date.now): CredentialVerifier {
  const digests: KeyDigest[] = []
  if (keys.admin !== null) digests.push({ role: 'admin', digest: digestOf(keys.admin) })
  if (keys.read !== null) digests.push({ role: 'read', digest: digestOf(keys.read) })
  const signing: SigningKeys = {
    admin: keys.admin === null ? null : Buffer.from(keys.admin, 'utf8'),
    read: keys.read === null ? null : Buffer.from(keys.read, 'utf8'),
  }

  function keyRole(value: string): Role | null {
    const presented = digestOf(value)
    let role: Role | null = null
    for (const key of digests) {
      if (timingSafeEqual(presented, key.digest)) role = key.role
    }
    return role
  }

  return {
    verify(ctx) {
      const value = presentedValue(ctx)
      if (value === null) return null
      const role = keyRole(value)
      if (role !== null) return { kind: 'key', role }
      const token = verifyToken(value, signing, now())
      return token === null ? null : { kind: 'token', role: token.role, token }
    },
  }
}
