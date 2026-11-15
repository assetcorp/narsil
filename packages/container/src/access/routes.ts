const NAME = '{name}'

const PROBE_PATHS: ReadonlySet<string> = new Set(['/livez', '/readyz', '/health', '/version'])

const GET_ROUTES_OUTSIDE_READ = [
  ['indexes', NAME, 'snapshot'],
  ['indexes', NAME, 'export'],
] as const

const POST_READ_ROUTES = [
  ['indexes', NAME, 'search'],
  ['indexes', NAME, 'search', 'preflight'],
  ['indexes', NAME, 'suggest'],
  ['indexes', NAME, 'documents', '_list'],
  ['indexes', NAME, 'documents', '_multi-get'],
  ['indexes', NAME, '_wait-for-writes'],
  ['indexes', NAME, 'query-suggestions', 'record'],
] as const

export interface RouteAccess {
  probe: boolean
  read: boolean
  indexName: string | null
}

function segmentsOf(path: string): string[] {
  return (path.startsWith('/') ? path.slice(1) : path).split('/')
}

function matches(segments: readonly string[], pattern: readonly string[]): boolean {
  if (segments.length !== pattern.length) return false
  return pattern.every((part, position) => part === NAME || part === segments[position])
}

function indexNameOf(segments: readonly string[]): string | null {
  if (segments.length < 2 || segments[0] !== 'indexes') return null
  try {
    return decodeURIComponent(segments[1])
  } catch {
    return null
  }
}

function isRead(method: string, segments: readonly string[]): boolean {
  if (method === 'GET' || method === 'HEAD') {
    return !GET_ROUTES_OUTSIDE_READ.some(pattern => matches(segments, pattern))
  }
  if (method === 'POST') return POST_READ_ROUTES.some(pattern => matches(segments, pattern))
  return false
}

export function routeAccessOf(method: string, path: string): RouteAccess {
  const verb = method.toUpperCase()
  const probe = (verb === 'GET' || verb === 'HEAD') && PROBE_PATHS.has(path)
  const segments = segmentsOf(path)
  return { probe, read: isRead(verb, segments), indexName: indexNameOf(segments) }
}
