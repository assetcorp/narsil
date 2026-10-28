import { encodePageCursor } from './cursor'

export interface PositionedHit {
  id: string
  score?: number
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
  start: number,
  end: number,
  available: number,
  pinnedIds: ReadonlySet<string> | undefined,
  binding: string,
): { page: T[]; cursor?: string } {
  if (end <= start) return { page: [] }
  const page = placed.slice(start, end)
  const last = lastOrganic(page, pinnedIds)
  if (Math.min(placed.length, available) <= end || last === undefined) return { page }
  const depth = pinnedIds === undefined ? start + page.lastIndexOf(last) + 1 : positionOf(organic, last.id) + 1
  const cursor = encodePageCursor({
    anchor: last.id,
    score: last.score ?? null,
    sortKey: null,
    sortSignature: null,
    depth,
    binding,
  })
  return { page, cursor }
}
