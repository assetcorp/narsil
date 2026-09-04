import { type ComparableSortValue, toComparableSortValue } from '../core/ordering'
import { SORT_VALUE_MAX_CODE_POINTS } from '../core/ordering/constants'
import { ErrorCodes, NarsilError } from '../errors'
import type { SortSpec } from '../types/search'
import {
  MAX_CURSOR_ANCHOR_CODE_POINTS,
  MAX_CURSOR_LENGTH,
  MAX_SORT_FIELD_NAME_LENGTH,
  MAX_SORT_FIELDS,
} from './constants'
import { decodeCursorText, encodeCursorText } from './cursor-codec'
import { normalizeSort } from './sorting'

export const CURSOR_VERSION = 3

/**
 * The decoded form of the paging cursor that search and listing share. The
 * anchor names the last document returned. One anchor mode applies: a score
 * for an unsorted search, a sort key with its sort order for a sorted page,
 * or neither for a listing in document ID order. The binding ties the cursor
 * to the request that produced it.
 */
export interface PageCursor {
  anchor: string
  score: number | null
  sortKey: ComparableSortValue[] | null
  sortSignature: string | null
  binding: string
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
 * Serialises a sort into the signature a sorted cursor carries, so that the
 * engine can reject a cursor sent back under a different sort.
 *
 * @param sort - The sort, keyed by field or listed in order, or undefined when the request has none.
 * @returns The signature text, or null when the request has no sort.
 * @throws SEARCH_INVALID_FIELD when the sort names more than eight fields, or a field name longer than 255 characters.
 */
export function sortSignatureOf(sort: SortSpec | undefined): string | null {
  const fields = normalizeSort(sort)
  if (fields.length === 0) return null

  if (fields.length > MAX_SORT_FIELDS) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FIELD,
      `A sort names at most ${MAX_SORT_FIELDS} fields, because the paging cursor carries one value per field`,
      { count: fields.length, limit: MAX_SORT_FIELDS },
    )
  }

  for (const entry of fields) {
    if (entry.field.length > MAX_SORT_FIELD_NAME_LENGTH) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_FIELD,
        `A sort field name holds at most ${MAX_SORT_FIELD_NAME_LENGTH} characters, because the paging cursor carries the sort with every page`,
        { field: entry.field.slice(0, 64), length: entry.field.length, limit: MAX_SORT_FIELD_NAME_LENGTH },
      )
    }
  }

  return JSON.stringify(fields.map(entry => [entry.field, entry.direction]))
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
  payload.q = cursor.binding
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
      if (exceedsCodePoints(entry, SORT_VALUE_MAX_CODE_POINTS)) {
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
 * Decodes a page cursor and checks every rule the specification's cursor
 * format sets. A cursor that fails any rule raises `SEARCH_INVALID_CURSOR`.
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

  const { v, a, s, k, o, q } = parsed as Record<string, unknown>
  if (v !== CURSOR_VERSION) throw invalidCursor(cursor, `unsupported cursor version ${String(v)}`)
  if (typeof q !== 'string' || !/^[0-9a-f]{8}$/.test(q)) {
    throw invalidCursor(cursor, '"q" must be 8 lowercase hex digits')
  }
  if (typeof a !== 'string' || a.length === 0) throw invalidCursor(cursor, '"a" must be a non-empty string')
  if (exceedsCodePoints(a, MAX_CURSOR_ANCHOR_CODE_POINTS)) {
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
    binding: q,
  }
}

/**
 * Rejects a cursor that belongs to a different request: one whose binding
 * differs, a sorted cursor under another sort, a sorted cursor on an unsorted
 * request, or a score cursor where the operation anchors on the document ID
 * alone.
 *
 * @param cursor - The decoded cursor.
 * @param encoded - The encoded text, used in the error.
 * @param signature - The request's own sort signature, or null when it has no sort.
 * @param scoreAnchored - True when an unsorted request anchors on the score, as a search does. False when it anchors on the document ID alone, as a listing does.
 * @param binding - The request's own cursor binding, from {@link queryBindingOf} or {@link listBindingOf}.
 */
export function requireMatchingCursor(
  cursor: PageCursor,
  encoded: string,
  signature: string | null,
  scoreAnchored: boolean,
  binding: string,
): void {
  if (cursor.binding !== binding) {
    throw invalidCursor(encoded, 'the cursor belongs to a different query')
  }
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
