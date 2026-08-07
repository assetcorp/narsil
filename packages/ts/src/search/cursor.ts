import { type ComparableSortValue, type SortDirection, toComparableSortValue } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import { decodeCursorText, encodeCursorText } from './cursor-codec'

export const CURSOR_VERSION = 2
export const MAX_CURSOR_LENGTH = 8192
export const MAX_SORT_FIELDS = 8
const MAX_ANCHOR_CODE_POINTS = 512
const MAX_SORT_VALUE_CODE_POINTS = 512

/**
 * The decoded form of the paging cursor that search and listing share. The
 * anchor names the last document returned, and exactly one anchor mode is set:
 * a score for an unsorted search, a sort key with its sort order for a sorted
 * page, or neither for a listing in document ID order.
 */
export interface PageCursor {
  anchor: string
  score: number | null
  sortKey: ComparableSortValue[] | null
  sortSignature: string | null
}

function invalidCursor(cursor: string, reason: string): NarsilError {
  const shown = cursor.length > 100 ? `${cursor.slice(0, 100)}...` : cursor
  return new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, `Failed to decode cursor: ${reason}`, { cursor: shown })
}

function exceedsCodePoints(value: string, maximum: number): boolean {
  if (value.length <= maximum) return false
  let counted = 0
  let i = 0
  while (i < value.length) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < value.length) {
      const low = value.charCodeAt(i + 1)
      if (low >= 0xdc00 && low < 0xe000) i++
    }
    i++
    counted++
    if (counted > maximum) return true
  }
  return false
}

/**
 * Serialises a sort into the signature a sorted cursor carries, so a cursor
 * can be rejected when it comes back under a different sort.
 *
 * @param sort - The sort, keyed by field, or undefined when the request has none.
 * @returns The signature text, or null when the request has no sort.
 * @throws SEARCH_INVALID_FIELD when the sort names more than eight fields.
 */
export function sortSignatureOf(sort: Record<string, SortDirection> | undefined): string | null {
  if (sort === undefined) return null
  const entries = Object.entries(sort)
  if (entries.length === 0) return null

  if (entries.length > MAX_SORT_FIELDS) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FIELD,
      `A sort names at most ${MAX_SORT_FIELDS} fields, because the paging cursor carries one value per field`,
      { count: entries.length, limit: MAX_SORT_FIELDS },
    )
  }

  return JSON.stringify(entries)
}

/**
 * Encodes a page cursor into the base64 text a client passes back to reach
 * the next page.
 *
 * @param cursor - The cursor to encode.
 * @returns The base64-encoded cursor text.
 */
export function encodePageCursor(cursor: PageCursor): string {
  const payload: Record<string, unknown> = { v: CURSOR_VERSION, a: cursor.anchor }
  if (cursor.sortKey !== null && cursor.sortSignature !== null) {
    payload.k = cursor.sortKey.map(toComparableSortValue)
    payload.o = cursor.sortSignature
  } else if (cursor.score !== null) {
    payload.s = cursor.score
  }
  return encodeCursorText(JSON.stringify(payload))
}

function decodeSortKey(value: unknown, cursor: string): ComparableSortValue[] {
  if (!Array.isArray(value)) throw invalidCursor(cursor, '"k" must be an array')
  if (value.length > MAX_SORT_FIELDS) throw invalidCursor(cursor, '"k" carries too many sort values')

  const key: ComparableSortValue[] = []
  for (const entry of value) {
    if (entry === null || typeof entry === 'boolean') {
      key.push(entry)
      continue
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw invalidCursor(cursor, '"k" holds a number that is not finite')
      key.push(entry)
      continue
    }
    if (typeof entry === 'string') {
      if (exceedsCodePoints(entry, MAX_SORT_VALUE_CODE_POINTS)) {
        throw invalidCursor(cursor, '"k" holds an oversized sort value')
      }
      key.push(entry)
      continue
    }
    throw invalidCursor(cursor, '"k" accepts a string, a finite number, a boolean, or null')
  }
  return key
}

/**
 * Decodes and validates a page cursor, applying every rule the specification's
 * cursor format sets, and raises `SEARCH_INVALID_CURSOR` when any fails.
 *
 * @param cursor - The base64-encoded cursor text a client passed back.
 * @returns The decoded cursor.
 */
export function decodePageCursor(cursor: string): PageCursor {
  if (cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor(cursor, 'the cursor is too long')

  let json: string
  try {
    json = decodeCursorText(cursor)
  } catch {
    throw invalidCursor(cursor, 'invalid base64 encoding')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw invalidCursor(cursor, 'invalid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor(cursor, 'expected an object')
  }

  const { v, a, s, k, o } = parsed as Record<string, unknown>
  if (v !== CURSOR_VERSION) throw invalidCursor(cursor, `unsupported cursor version ${String(v)}`)
  if (typeof a !== 'string' || a.length === 0) throw invalidCursor(cursor, '"a" must be a non-empty string')
  if (exceedsCodePoints(a, MAX_ANCHOR_CODE_POINTS)) {
    throw invalidCursor(cursor, '"a" is too long to be a document id')
  }

  if (s !== undefined && (typeof s !== 'number' || !Number.isFinite(s))) {
    throw invalidCursor(cursor, '"s" must be a finite number')
  }
  if (s !== undefined && k !== undefined) throw invalidCursor(cursor, 'a cursor carries "s" or "k", never both')

  const sortKey = k === undefined ? null : decodeSortKey(k, cursor)
  if (o !== undefined && typeof o !== 'string') throw invalidCursor(cursor, '"o" must be a string')
  if ((sortKey === null) !== (o === undefined)) {
    throw invalidCursor(cursor, '"k" and "o" have to arrive together')
  }

  return {
    anchor: a,
    score: typeof s === 'number' ? s : null,
    sortKey,
    sortSignature: typeof o === 'string' ? o : null,
  }
}

/**
 * Rejects a cursor that belongs to a different request shape: a sorted cursor
 * under another sort, a sorted cursor on an unsorted request, or a score
 * cursor where the operation anchors on the document ID alone.
 *
 * @param cursor - The decoded cursor.
 * @param encoded - The encoded text, used in the error.
 * @param signature - The request's own sort signature, or null when it has no sort.
 * @param scoreAnchored - True when an unsorted request anchors on the score, as a search does, and false when it anchors on the document ID alone, as a listing does.
 */
export function requireMatchingCursor(
  cursor: PageCursor,
  encoded: string,
  signature: string | null,
  scoreAnchored: boolean,
): void {
  if (signature !== null) {
    if (cursor.sortSignature !== signature) {
      throw invalidCursor(encoded, 'the cursor belongs to a different sort order')
    }
    return
  }
  if (cursor.sortSignature !== null) {
    throw invalidCursor(encoded, 'the cursor belongs to a sorted request')
  }
  if (scoreAnchored && cursor.score === null) {
    throw invalidCursor(encoded, 'the cursor carries no score to seek from')
  }
  if (!scoreAnchored && cursor.score !== null) {
    throw invalidCursor(encoded, 'the cursor belongs to a search rather than a listing')
  }
}
