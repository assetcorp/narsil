import { MAX_SYNC_INDEX_NAME_LENGTH, readBoundedText } from '@delali/narsil-example-shared/lib/bounded-read'
import { createFileRoute } from '@tanstack/react-router'
import * as v from 'valibot'

const MAX_GRANT_REQUEST_BYTES = 1024

const GrantRequestSchema = v.object({
  indexName: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SYNC_INDEX_NAME_LENGTH)),
})

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function parseGrantRequest(text: string): v.InferOutput<typeof GrantRequestSchema> | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = v.safeParse(GrantRequestSchema, raw)
  return parsed.success ? parsed.output : null
}

async function grant(request: Request): Promise<Response> {
  const text = await readBoundedText(request, MAX_GRANT_REQUEST_BYTES)
  if (text === null) return errorResponse(413, 'INVALID_REQUEST', 'The grant request is too large')
  const body = parseGrantRequest(text)
  if (body === null) return errorResponse(400, 'INVALID_REQUEST', 'The body must be {"indexName": "<name>"}')

  const { mintSyncGrant, syncGrantLifetimeFromEnv, syncGrantSecretFromEnv } = await import('#/lib/sync-grant')
  const secret = syncGrantSecretFromEnv(process.env)
  if (secret === null) {
    return errorResponse(503, 'SERVICE_UNAVAILABLE', 'Device sync grants need the bundled demo server')
  }
  let lifetimeMs: number
  try {
    lifetimeMs = syncGrantLifetimeFromEnv(process.env)
  } catch (err) {
    return errorResponse(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
  }

  const minted = mintSyncGrant(secret, body.indexName, lifetimeMs, Date.now())
  return new Response(JSON.stringify(minted), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const Route = createFileRoute('/api/sync-grant')({
  server: {
    handlers: {
      POST: ({ request }) => grant(request),
    },
  },
})
