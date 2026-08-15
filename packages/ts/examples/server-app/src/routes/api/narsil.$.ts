import { createFileRoute } from '@tanstack/react-router'

const PREFIX = '/api/narsil'
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept']
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control']

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Passes a browser request on to the search server with the API key attached.
 * The browser therefore reaches every route the client SDK uses without ever
 * holding a credential, which is the arrangement a deployed app wants.
 */
async function forward(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.slice(PREFIX.length)
  if (path.length > 0 && !path.startsWith('/')) {
    return errorResponse(400, 'INVALID_REQUEST', 'The proxied path is malformed')
  }

  const [{ readServerConfig }, { demoServerPromise }] = await Promise.all([
    import('#/lib/server-config'),
    import('#/lib/demo-server-state'),
  ])

  const starting = demoServerPromise()
  if (starting) await starting

  let target: string
  let apiKey: string | undefined
  try {
    const config = readServerConfig()
    target = `${config.baseUrl}${path}${url.search}`
    apiKey = config.apiKey
  } catch (err) {
    return errorResponse(503, 'SERVICE_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`)

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? 'half' : undefined,
      signal: request.signal,
    } as RequestInit)
  } catch (err) {
    return errorResponse(
      502,
      'SERVICE_UNAVAILABLE',
      `The search server did not answer: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const responseHeaders = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) responseHeaders.set(name, value)
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

export const Route = createFileRoute('/api/narsil/$')({
  server: {
    handlers: {
      GET: ({ request }) => forward(request),
      POST: ({ request }) => forward(request),
      PUT: ({ request }) => forward(request),
      PATCH: ({ request }) => forward(request),
      DELETE: ({ request }) => forward(request),
    },
  },
})
