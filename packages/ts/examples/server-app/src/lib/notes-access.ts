import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import * as v from 'valibot'
import { MAX_NOTES_COOKIE_LENGTH, NOTES_COOKIE_MAX_AGE_SECONDS, NOTES_COOKIE_NAME } from './constants.ts'

const SpaceSchema = v.pipe(v.string(), v.uuid(), v.regex(/^[0-9a-f-]+$/))

function signature(secret: string, space: string): string {
  return createHmac('sha256', secret).update(`notes-cookie-v1\n${space}`).digest('base64url')
}
export function notesSpaceFromCookie(header: string | null, secret: string): string | null {
  const values = (header ?? '')
    .split(';')
    .map(value => value.trim())
    .filter(value => value.startsWith(`${NOTES_COOKIE_NAME}=`))
  if (values.length !== 1) return null
  const value = values[0]?.slice(NOTES_COOKIE_NAME.length + 1)
  if (value === undefined || value.length > MAX_NOTES_COOKIE_LENGTH) return null
  const [space, mac, extra] = value.split('.')
  if (space === undefined || mac === undefined || extra !== undefined || !v.is(SpaceSchema, space)) return null
  const expected = Buffer.from(signature(secret, space))
  const presented = Buffer.from(mac)
  return expected.length === presented.length && timingSafeEqual(expected, presented) ? space : null
}

export function hasNotesCookie(header: string | null): boolean {
  return (header ?? '').split(';').some(value => value.trim().startsWith(`${NOTES_COOKIE_NAME}=`))
}

export function newNotesSpace(): string {
  return randomUUID()
}

export function notesCookie(secret: string, space: string, secure: boolean): string {
  return `${NOTES_COOKIE_NAME}=${space}.${signature(secret, space)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${NOTES_COOKIE_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`
}

export function sameOrigin(request: Request): URL | null {
  const raw = request.headers.get('origin')
  if (raw === null) return null
  try {
    const origin = new URL(raw)
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin') return null
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null
    return origin.host === request.headers.get('host') ? origin : null
  } catch {
    return null
  }
}
