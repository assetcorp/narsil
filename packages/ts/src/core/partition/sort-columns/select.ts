import {
  type ComparableSortValue,
  compareCodePoints,
  compareComparableValues,
  type SortDirection,
} from '../../ordering'
import type { PartitionFilterMatches } from '../filters'
import type { PartitionState } from '../utils'
import type { SortColumn } from './index'
import { MISSING_RANK, rankIsBetweenValues, rankOfValue } from './order'

export interface SortPageRequest {
  fields: readonly string[]
  directions: readonly SortDirection[]
  fieldTypes: readonly (string | undefined)[]
  limit: number
  anchorKey: readonly ComparableSortValue[] | null
  anchorId: string | null
  matches: PartitionFilterMatches | null
}

export interface SortedPageEntry {
  id: string
  key: ComparableSortValue[]
}

interface Candidate {
  internalId: number
  externalId: string
  leadingRank: number
  key: ComparableSortValue[]
}

function rankOrdersAfter(rank: number, other: number, direction: SortDirection): boolean {
  if (rank === MISSING_RANK) return other !== MISSING_RANK
  if (other === MISSING_RANK) return false
  return direction === 'asc' ? rank > other : rank < other
}

function compareColumnValue(column: SortColumn, aId: number, bId: number, direction: SortDirection): number {
  const aRank = column.rankOf(aId)
  const bRank = column.rankOf(bId)
  if (aRank === MISSING_RANK && bRank === MISSING_RANK) return 0
  if (aRank === MISSING_RANK) return 1
  if (bRank === MISSING_RANK) return -1
  if (aRank !== bRank) {
    const ascending = aRank < bRank ? -1 : 1
    return direction === 'desc' ? -ascending : ascending
  }
  if (!rankIsBetweenValues(aRank)) return 0
  return compareComparableValues(column.valueOf(aId), column.valueOf(bId), direction)
}

function compareCandidates(
  columns: readonly SortColumn[],
  directions: readonly SortDirection[],
  a: Candidate,
  b: Candidate,
): number {
  for (let i = 0; i < columns.length; i++) {
    const comparison = compareColumnValue(columns[i], a.internalId, b.internalId, directions[i])
    if (comparison !== 0) return comparison
  }
  return compareCodePoints(a.externalId, b.externalId)
}

function compareWithAnchor(
  columns: readonly SortColumn[],
  directions: readonly SortDirection[],
  candidate: Candidate,
  anchorKey: readonly ComparableSortValue[],
  anchorId: string,
): number {
  for (let i = 0; i < columns.length; i++) {
    const comparison = compareComparableValues(candidate.key[i], anchorKey[i] ?? null, directions[i])
    if (comparison !== 0) return comparison
  }
  return compareCodePoints(candidate.externalId, anchorId)
}

function insertOrdered(
  page: Candidate[],
  entry: Candidate,
  columns: readonly SortColumn[],
  directions: readonly SortDirection[],
): void {
  let low = 0
  let high = page.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (compareCandidates(columns, directions, page[mid], entry) <= 0) low = mid + 1
    else high = mid
  }
  page.splice(low, 0, entry)
}

function seekDirtyPosition(column: SortColumn, present: Int32Array, rank: number, direction: SortDirection): number {
  let low = 0
  let high = present.length
  if (direction === 'asc') {
    while (low < high) {
      const mid = (low + high) >>> 1
      if (column.rankOf(present[mid]) < rank) low = mid + 1
      else high = mid
    }
    return low
  }
  while (low < high) {
    const mid = (low + high) >>> 1
    if (column.rankOf(present[mid]) <= rank) low = mid + 1
    else high = mid
  }
  return low - 1
}

function createStream(column: SortColumn, direction: SortDirection, anchorRank: number | null): () => number {
  const ordered = column.order.ordered
  const dirty = column.dirtyStream()
  const step = direction === 'asc' ? 1 : -1
  const anchorIsMissing = anchorRank === MISSING_RANK

  let builtIndex = direction === 'asc' ? 0 : ordered.length - 1
  let dirtyIndex = direction === 'asc' ? 0 : dirty.present.length - 1
  if (anchorRank !== null && !anchorIsMissing) {
    builtIndex = column.seek(anchorRank, direction)
    dirtyIndex = seekDirtyPosition(column, dirty.present, anchorRank, direction)
  }

  let presentExhausted = anchorIsMissing
  let builtMissingIndex = 0
  let dirtyMissingIndex = 0

  function peekBuilt(): number {
    while (builtIndex >= 0 && builtIndex < ordered.length) {
      if (!column.isDirty(ordered[builtIndex])) return ordered[builtIndex]
      builtIndex += step
    }
    return -1
  }

  function peekDirty(): number {
    if (dirtyIndex < 0 || dirtyIndex >= dirty.present.length) return -1
    return dirty.present[dirtyIndex]
  }

  function nextMissing(): number {
    const builtMissing = column.order.missing
    while (builtMissingIndex < builtMissing.length) {
      const internalId = builtMissing[builtMissingIndex]
      builtMissingIndex++
      if (!column.isDirty(internalId)) return internalId
    }
    if (dirtyMissingIndex < dirty.missing.length) {
      const internalId = dirty.missing[dirtyMissingIndex]
      dirtyMissingIndex++
      return internalId
    }
    return -1
  }

  return function next(): number {
    if (!presentExhausted) {
      const builtId = peekBuilt()
      const dirtyId = peekDirty()
      if (builtId === -1 && dirtyId === -1) {
        presentExhausted = true
      } else if (dirtyId === -1) {
        builtIndex += step
        return builtId
      } else if (builtId === -1) {
        dirtyIndex += step
        return dirtyId
      } else if (rankOrdersAfter(column.rankOf(dirtyId), column.rankOf(builtId), direction)) {
        builtIndex += step
        return builtId
      } else {
        dirtyIndex += step
        return dirtyId
      }
    }
    return nextMissing()
  }
}

export function selectSortedPage(state: PartitionState, request: SortPageRequest): SortedPageEntry[] {
  const { fields, directions, fieldTypes, limit, anchorKey, anchorId, matches } = request
  if (limit <= 0 || fields.length === 0) return []

  const set = state.sortColumns
  if (set === null) return []

  const columns = fields.map((field, index) => set.column(field, fieldTypes[index]))
  const resolver = state.docStore.resolver()
  const leading = columns[0]
  const leadingDirection = directions[0]

  const anchorRank = anchorKey === null || anchorId === null ? null : rankOfValue(leading.order, anchorKey[0] ?? null)
  const next = createStream(leading, leadingDirection, anchorRank)

  const page: Candidate[] = []

  for (;;) {
    const internalId = next()
    if (internalId === -1) break

    if (matches !== null && !matches.hasInternal(internalId)) continue

    const externalId = resolver.toExternal(internalId)
    if (externalId === undefined) continue

    const leadingRank = leading.rankOf(internalId)
    if (page.length === limit && rankOrdersAfter(leadingRank, page[limit - 1].leadingRank, leadingDirection)) {
      break
    }

    const key: ComparableSortValue[] = new Array(columns.length)
    for (let i = 0; i < columns.length; i++) key[i] = columns[i].valueOf(internalId)
    const candidate: Candidate = { internalId, externalId, leadingRank, key }

    if (anchorKey !== null && anchorId !== null) {
      if (compareWithAnchor(columns, directions, candidate, anchorKey, anchorId) <= 0) continue
    }

    if (page.length === limit) {
      if (compareCandidates(columns, directions, candidate, page[limit - 1]) >= 0) continue
      page.pop()
    }

    insertOrdered(page, candidate, columns, directions)
  }

  return page.map(entry => ({ id: entry.externalId, key: entry.key }))
}
