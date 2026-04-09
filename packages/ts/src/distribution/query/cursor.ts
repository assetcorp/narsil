import { ErrorCodes, NarsilError } from '../../errors'

export const MAX_CURSOR_LENGTH = 4096
const MAX_CURSOR_DOC_ID_LENGTH = 512

export interface DistributedCursor {
  s: number
  d: string
}

function truncateCursorForError(encoded: string): string {
  if (encoded.length > 100) {
    return `${encoded.slice(0, 100)}...`
  }
  return encoded
}

export function encodeDistributedCursor(score: number, docId: string): string {
  const json = JSON.stringify({ s: score, d: docId })
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json).toString('base64')
  }
  return btoa(json)
}

export function decodeDistributedCursor(encoded: string): DistributedCursor {
  if (encoded.length > MAX_CURSOR_LENGTH) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_CURSOR,
      `Distributed cursor exceeds maximum length of ${MAX_CURSOR_LENGTH}`,
      { cursor: truncateCursorForError(encoded) },
    )
  }

  let json: string
  try {
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(encoded, 'base64').toString('utf-8')
    } else {
      json = atob(encoded)
    }
  } catch {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_CURSOR,
      'Failed to decode distributed cursor: invalid base64 encoding',
      { cursor: truncateCursorForError(encoded) },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, 'Failed to decode distributed cursor: invalid JSON', {
      cursor: truncateCursorForError(encoded),
    })
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_CURSOR,
      'Invalid distributed cursor structure: expected an object with "s" and "d" fields',
      { cursor: truncateCursorForError(encoded) },
    )
  }

  const record = parsed as Record<string, unknown>
  const { s, d } = record

  if (typeof s !== 'number' || !Number.isFinite(s)) {
    throw new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, 'Invalid distributed cursor: "s" must be a finite number', {
      cursor: truncateCursorForError(encoded),
    })
  }

  if (typeof d !== 'string' || d.length === 0) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_CURSOR,
      'Invalid distributed cursor: "d" must be a non-empty string',
      { cursor: truncateCursorForError(encoded) },
    )
  }

  if (d.length > MAX_CURSOR_DOC_ID_LENGTH) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_CURSOR,
      `Invalid distributed cursor: "d" exceeds maximum length of ${MAX_CURSOR_DOC_ID_LENGTH}`,
      { cursor: truncateCursorForError(encoded) },
    )
  }

  if (d.includes('\0')) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_CURSOR,
      'Invalid distributed cursor: "d" must not contain null bytes',
      { cursor: truncateCursorForError(encoded) },
    )
  }

  return { s, d }
}
