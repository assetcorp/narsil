import { readBoundedText } from '@delali/narsil-example-shared/lib/bounded-read'
import * as v from 'valibot'
import { MAX_INDEX_REQUEST_BYTES, NOTES_INDEX_PREFIX } from './constants'
import { notesSpaceFromCookie } from './notes-access'
import { notesError } from './notes-identity'
import { isNotesIndex, notesRequestScope, validProxyPath } from './notes-scope'
import { syncGrantSecretFromEnv } from './sync-grant'

const IndexRequestSchema = v.object({ name: v.string() })
const IndexListSchema = v.object({ indexes: v.array(v.looseObject({ name: v.string() })) })
const DATASET_PATH =
  /^\/indexes\/[^/]+(?:\/(?:stats|partitions|cluster|replication-factor|count|_clear|_open|_close|_checkpoint|_wait-for-writes|_rebuild-analysis|_change-analysis|snapshot|restore|export|import|vector-maintenance|vectors\/(?:_compact|_optimize)|_rebalance|partition-config|synonyms|bm25|search(?:\/preflight)?|suggest|sync|backups|documents(?:\/[^/]+(?:\/_exists)?)?|query-suggestions(?:\/[^/]+)?))?$/

export async function proxyAccess(
  request: Request,
  path: string,
): Promise<{ body?: string; notes: boolean } | Response> {
  if (!validProxyPath(path)) return notesError(400, 'INVALID_REQUEST', 'The proxied path is malformed')
  const query = new URL(request.url).searchParams
  if ([...query.values()].some(value => value.includes(NOTES_INDEX_PREFIX))) {
    return notesError(403, 'FORBIDDEN', 'Queries cannot identify personal notes')
  }
  const scope = notesRequestScope(path, request.method)
  if (scope !== null) {
    const secret = syncGrantSecretFromEnv(process.env)
    const space = secret === null ? null : notesSpaceFromCookie(request.headers.get('cookie'), secret)
    if (!scope.syncAllowed || query.size > 0 || space === null || scope.indexName !== `${NOTES_INDEX_PREFIX}${space}`) {
      return notesError(403, 'FORBIDDEN', 'This route does not admit this notes space')
    }
    if (!request.headers.has('authorization')) return notesError(401, 'UNAUTHORIZED', 'A sync grant is required')
    return { notes: true }
  }
  if (request.headers.has('authorization'))
    return notesError(403, 'FORBIDDEN', 'A sync grant cannot administer datasets')
  if (
    !DATASET_PATH.test(path) &&
    !/^\/(indexes|health|livez|readyz|version|capabilities|stats\/memory|tasks(?:\/[^/]+(?:\/_cancel)?)?)$/.test(path)
  ) {
    return notesError(403, 'FORBIDDEN', 'This proxy serves dataset routes only')
  }
  if (path === '/indexes' && request.method === 'POST') {
    const body = await readBoundedText(request, MAX_INDEX_REQUEST_BYTES)
    if (body === null) return notesError(413, 'INVALID_REQUEST', 'The index request is too large')
    try {
      const parsed = v.safeParse(IndexRequestSchema, JSON.parse(body))
      if (!parsed.success || isNotesIndex(parsed.output.name)) {
        return notesError(403, 'FORBIDDEN', 'The notes namespace is reserved')
      }
    } catch {
      return notesError(400, 'INVALID_REQUEST', 'The index request must be JSON')
    }
    return { notes: false, body }
  }
  return { notes: false }
}

export async function publicIndexList(response: Response): Promise<Response> {
  const text = await readBoundedText(response, MAX_INDEX_REQUEST_BYTES)
  if (text === null) return notesError(502, 'SERVICE_UNAVAILABLE', 'The index list is too large')
  try {
    const raw: unknown = JSON.parse(text)
    const parsed = v.safeParse(IndexListSchema, raw)
    if (!parsed.success) return notesError(502, 'SERVICE_UNAVAILABLE', 'The index list is invalid')
    const indexes = parsed.output.indexes.filter(index => !isNotesIndex(index.name))
    return Response.json({ indexes }, { headers: { 'cache-control': 'no-store' } })
  } catch {
    return notesError(502, 'SERVICE_UNAVAILABLE', 'The index list is invalid')
  }
}
