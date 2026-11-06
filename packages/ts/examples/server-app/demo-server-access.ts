import { createHash, timingSafeEqual } from 'node:crypto'
import type { OnRequestHook, RequestContext, RequestDenial } from '@delali/narsil/server'
import { offeredFeedCredential, verifySyncGrant } from './src/lib/sync-grant.ts'

const SYNC_FEED_PATH = /^\/indexes\/([^/]+)\/sync\/feed$/

const MISSING_API_KEY: RequestDenial = { status: 401, code: 'UNAUTHORIZED', message: 'A valid API key is required' }
const INVALID_SYNC_GRANT: RequestDenial = {
  status: 401,
  code: 'UNAUTHORIZED',
  message: 'The sync feed needs a current grant for this index',
}

function sameSecret(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function presentedKey(ctx: RequestContext): string | undefined {
  const header = ctx.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  return bearer ?? ctx.headers['x-api-key']
}

function feedCredential(protocolHeader: string | undefined): string | undefined {
  const credential = offeredFeedCredential(protocolHeader)?.credential
  return credential !== undefined && credential.length > 0 ? credential : undefined
}

function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function admissionHook(apiKey: string | undefined, grantSecret: string | null): OnRequestHook {
  return ctx => {
    if (apiKey !== undefined) {
      const presented = presentedKey(ctx)
      if (presented === undefined || !sameSecret(presented, apiKey)) return MISSING_API_KEY
    }
    const feed = SYNC_FEED_PATH.exec(ctx.path)
    const segment = feed?.[1]
    if (segment === undefined) return undefined

    const indexName = decodedSegment(segment)
    const credential = feedCredential(ctx.headers['sec-websocket-protocol'])
    if (grantSecret === null || indexName === null || credential === undefined) return INVALID_SYNC_GRANT
    const expiresAt = verifySyncGrant(grantSecret, credential, indexName, Date.now())
    return expiresAt === null ? INVALID_SYNC_GRANT : { expiresAt }
  }
}
