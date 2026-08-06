import { ErrorCodes, NarsilError } from '../../errors'
import { decodeCursorText, encodeCursorText } from '../../search/cursor-codec'
import type { SortDirection } from '../../search/sorting'

const CURSOR_VERSION = 1
const MAX_ANCHOR_LENGTH = 512
const MAX_SORT_SIGNATURE_LENGTH = 256

export const MAX_SORT_FIELDS = 8
export const MAX_SORT_VALUE_LENGTH = 512

export const MAX_CURSOR_LENGTH = 8192

export type SortKeyValue = string | number | boolean | null

export interface ListCursor {
  anchor: string
  sortKey: SortKeyValue[] | null
  sortSignature: string | null
}

function invalidCursor(cursor: string, reason: string): NarsilError {
  return new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, `Failed to decode listing cursor: ${reason}`, { cursor })
}

export function sortSignatureOf(sort: Record<string, SortDirection> | undefined): string | null {
  if (sort === undefined) return null
  const entries = Object.entries(sort)
  if (entries.length === 0) return null

  if (entries.length > MAX_SORT_FIELDS) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FIELD,
      `A listing sorts by at most ${MAX_SORT_FIELDS} fields, because the paging cursor carries one value per field`,
      { count: entries.length, limit: MAX_SORT_FIELDS },
    )
  }

  const signature = JSON.stringify(entries)
  if (signature.length > MAX_SORT_SIGNATURE_LENGTH) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_FIELD,
      `The sort names fields too long to fit a paging cursor, which holds ${MAX_SORT_SIGNATURE_LENGTH} characters of field names`,
      { length: signature.length, limit: MAX_SORT_SIGNATURE_LENGTH },
    )
  }

  return signature
}

export function toSortKey(value: unknown): SortKeyValue {
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length > MAX_SORT_VALUE_LENGTH ? value.slice(0, MAX_SORT_VALUE_LENGTH) : value
  }
  return null
}

export function encodeListCursor(cursor: ListCursor): string {
  const payload: Record<string, unknown> = { v: CURSOR_VERSION, a: cursor.anchor }
  if (cursor.sortKey !== null) payload.k = cursor.sortKey
  if (cursor.sortSignature !== null) payload.s = cursor.sortSignature
  return encodeCursorText(JSON.stringify(payload))
}

function decodeSortKey(value: unknown, cursor: string): SortKeyValue[] {
  if (!Array.isArray(value)) throw invalidCursor(cursor, '"k" must be an array')
  if (value.length > MAX_SORT_FIELDS) throw invalidCursor(cursor, '"k" carries too many sort values')

  const key: SortKeyValue[] = []
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
      if (entry.length > MAX_SORT_VALUE_LENGTH) throw invalidCursor(cursor, '"k" holds an oversized sort value')
      key.push(entry)
      continue
    }
    throw invalidCursor(cursor, '"k" accepts a string, a finite number, a boolean, or null')
  }
  return key
}

export function decodeListCursor(cursor: string): ListCursor {
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

  const { v, a, k, s } = parsed as Record<string, unknown>
  if (v !== CURSOR_VERSION) throw invalidCursor(cursor, `unsupported cursor version ${String(v)}`)
  if (typeof a !== 'string' || a.length === 0) throw invalidCursor(cursor, '"a" must be a non-empty string')
  if (a.length > MAX_ANCHOR_LENGTH) throw invalidCursor(cursor, '"a" is too long to be a document id')

  const sortKey = k === undefined ? null : decodeSortKey(k, cursor)

  if (s !== undefined && typeof s !== 'string') throw invalidCursor(cursor, '"s" must be a string')
  if (typeof s === 'string' && s.length > MAX_SORT_SIGNATURE_LENGTH) {
    throw invalidCursor(cursor, '"s" is too long to be a sort order')
  }
  const sortSignature = s === undefined ? null : s

  if (sortKey === null && sortSignature !== null) throw invalidCursor(cursor, 'a sorted cursor has to carry "k"')
  if (sortKey !== null && sortSignature === null) throw invalidCursor(cursor, 'a sorted cursor has to carry "s"')

  return { anchor: a, sortKey, sortSignature }
}

export function requireMatchingSort(cursor: ListCursor, encoded: string, signature: string | null): void {
  if (cursor.sortSignature === signature) return
  throw invalidCursor(encoded, 'the cursor belongs to a different sort order')
}
