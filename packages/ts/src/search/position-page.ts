import type { PageCursor } from './cursor'

export interface PositionedHit {
  id: string
  score?: number
}

export interface PositionedPage {
  start: number
  limit: number
  pinnedIds: ReadonlySet<string> | undefined
  binding: string
  encodeCursor(cursor: PageCursor): string
}

function lastOrganic<T extends PositionedHit>(page: T[], pinnedIds: ReadonlySet<string> | undefined): T | undefined {
  for (let i = page.length - 1; i >= 0; i--) {
    if (pinnedIds === undefined || !pinnedIds.has(page[i].id)) return page[i]
  }
  return undefined
}

function positionOf<T extends PositionedHit>(organic: T[], id: string): number {
  for (let i = 0; i < organic.length; i++) {
    if (organic[i].id === id) return i
  }
  return -1
}

export function pageByPosition<T extends PositionedHit>(
  placed: T[],
  organic: T[],
  { start, limit, pinnedIds, binding, encodeCursor }: PositionedPage,
): { page: T[]; cursor?: string } {
  if (limit <= 0) return { page: [] }
  const page = placed.slice(start, start + limit)
  const last = lastOrganic(page, pinnedIds)
  if (placed.length <= start + limit || last === undefined) return { page }
  const depth = pinnedIds === undefined ? start + page.lastIndexOf(last) + 1 : positionOf(organic, last.id) + 1
  const cursor = encodeCursor({
    anchor: last.id,
    score: last.score ?? null,
    sortKey: null,
    sortSignature: null,
    depth,
    binding,
  })
  return { page, cursor }
}
