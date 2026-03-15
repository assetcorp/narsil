import { ErrorCodes, NarsilError } from '../errors'

export interface SearchCursor {
  s: number
  d: string
  p: number
}

export function encodeCursor(state: SearchCursor[]): string {
  const json = JSON.stringify(state)
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json).toString('base64')
  }
  return btoa(json)
}

export function decodeCursor(encoded: string): SearchCursor[] {
  let json: string
  try {
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(encoded, 'base64').toString('utf-8')
    } else {
      json = atob(encoded)
    }
  } catch {
    throw new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, 'Failed to decode cursor: invalid base64 encoding', {
      cursor: encoded,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, 'Failed to decode cursor: invalid JSON', {
      cursor: encoded,
    })
  }

  if (!Array.isArray(parsed)) {
    throw new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, 'Invalid cursor structure: expected an array', {
      cursor: encoded,
    })
  }

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (typeof entry !== 'object' || entry === null) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_CURSOR,
        `Invalid cursor entry at index ${i}: expected an object`,
        {
          cursor: encoded,
          index: i,
        },
      )
    }

    const { s, d, p } = entry as Record<string, unknown>

    if (typeof s !== 'number' || !Number.isFinite(s)) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_CURSOR,
        `Invalid cursor entry at index ${i}: "s" must be a finite number`,
        { cursor: encoded, index: i },
      )
    }

    if (typeof d !== 'string') {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_CURSOR,
        `Invalid cursor entry at index ${i}: "d" must be a string`,
        { cursor: encoded, index: i },
      )
    }

    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) {
      throw new NarsilError(
        ErrorCodes.SEARCH_INVALID_CURSOR,
        `Invalid cursor entry at index ${i}: "p" must be a non-negative integer`,
        { cursor: encoded, index: i },
      )
    }
  }

  return parsed as SearchCursor[]
}

export function applyPagination<T extends { id: string; score: number }>(
  results: T[],
  limit: number,
  offset: number,
  cursor?: string,
): { paginated: T[]; nextCursor?: string } {
  if (limit === 0) {
    return { paginated: [] }
  }

  let startIndex = 0

  if (cursor) {
    const cursorState = decodeCursor(cursor)
    const anchor = cursorState[0]

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.score < anchor.s || (result.score === anchor.s && result.id > anchor.d)) {
        startIndex = i
        break
      }
      if (i === results.length - 1) {
        startIndex = results.length
      }
    }
  }

  const afterOffset = startIndex + offset
  const sliced = results.slice(afterOffset, afterOffset + limit)

  let nextCursor: string | undefined

  const hasMore = afterOffset + limit < results.length
  if (hasMore && sliced.length > 0) {
    const lastResult = sliced[sliced.length - 1]
    const cursorState: SearchCursor[] = [{ s: lastResult.score, d: lastResult.id, p: 0 }]
    nextCursor = encodeCursor(cursorState)
  }

  return { paginated: sliced, nextCursor }
}
