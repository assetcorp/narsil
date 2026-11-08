import { readBoundedText } from '@delali/narsil-example-shared/lib/bounded-read'
import * as v from 'valibot'
import { MAX_NOTES_REQUEST_BYTES, NOTES_INDEX_PREFIX } from './constants'
import { demoServerPromise } from './demo-server-state'
import { hasNotesCookie, newNotesSpace, notesCookie, notesSpaceFromCookie, sameOrigin } from './notes-access'
import { ensureNotesSpace } from './notes-space'
import { mintSyncGrant, syncGrantLifetimeFromEnv, syncGrantSecretFromEnv } from './sync-grant'

export function notesError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })
}

export async function notesIdentity(request: Request, create: boolean): Promise<Response> {
  const origin = sameOrigin(request)
  if (origin === null) return notesError(403, 'FORBIDDEN', 'A same-origin request is required')
  const text = await readBoundedText(request, MAX_NOTES_REQUEST_BYTES)
  if (text === null) return notesError(413, 'INVALID_REQUEST', 'The notes request is too large')
  try {
    if (!v.is(v.object({}), JSON.parse(text))) return notesError(400, 'INVALID_REQUEST', 'A JSON object is required')
  } catch {
    return notesError(400, 'INVALID_REQUEST', 'A JSON object is required')
  }
  const starting = demoServerPromise()
  if (starting !== undefined) await starting
  const secret = syncGrantSecretFromEnv(process.env)
  if (secret === null) return notesError(503, 'SERVICE_UNAVAILABLE', 'Device sync needs the bundled demo server')
  const header = request.headers.get('cookie')
  const existing = notesSpaceFromCookie(header, secret)
  if (existing === null && (!create || hasNotesCookie(header))) {
    return notesError(401, 'UNAUTHORIZED', 'A valid notes cookie is required')
  }
  const space = existing ?? newNotesSpace()
  const indexName = `${NOTES_INDEX_PREFIX}${space}`
  await ensureNotesSpace(indexName)
  const payload = create
    ? { space, indexName }
    : { indexName, ...mintSyncGrant(secret, indexName, syncGrantLifetimeFromEnv(process.env), Date.now()) }
  const headers = new Headers({ 'cache-control': 'no-store' })
  if (create) headers.set('set-cookie', notesCookie(secret, space, origin.protocol === 'https:'))
  return Response.json(payload, { headers })
}
