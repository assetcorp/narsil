import { sortSelect } from '#platform/sort-value'
import {
  compareCodePoints,
  defaultSortMode,
  ErrorCodes,
  NarsilError,
} from '../../../engine/optional-reads-host-bindings'
import type { ComparableSortValue, SortDirection, SortMode } from '../../ordering'
import { compareComparableKeys } from '../../ordering/sort-comparison'
import type { PartitionFilterMatches } from '../filters'
import type { PartitionReadState } from '../utils'
import { rankOfValue } from './order'
import { createValueStore } from './values'

export interface SortPageRequest {
  fields: readonly string[]
  directions: readonly SortDirection[]
  fieldTypes: readonly (string | undefined)[]
  modes: readonly SortMode[]
  limit: number
  anchorKey: readonly ComparableSortValue[] | null
  anchorId: string | null
  matches: PartitionFilterMatches | null
}

export interface SortedPageEntry {
  id: string
  key: ComparableSortValue[]
}

const emptyMatches = new Uint32Array(1)

export function selectSortedPage(state: PartitionReadState, request: SortPageRequest): SortedPageEntry[] {
  const { fields, directions, fieldTypes, modes, limit, anchorKey, anchorId, matches } = request
  if (limit <= 0 || fields.length === 0 || state.sortColumns === null) return []
  const set = state.sortColumns
  const columns = fields.map((field, index) =>
    set.column(field, fieldTypes[index], modes[index] ?? defaultSortMode(directions[index] ?? 'asc')),
  )
  const regions = columns.map(column => column.regions())
  const orders = Uint8Array.from(directions, direction => (direction === 'desc' ? 1 : 0))
  const live = set.liveBitset()
  const matched = matches === null ? live : matches.ordinalBitset()
  const filter = matched.length === 0 ? emptyMatches : matched
  const anchorStore = anchorKey === null || anchorId === null ? null : createValueStore()
  const anchorRanks = anchorStore === null ? null : new Int32Array(columns.length)
  if (anchorStore !== null && anchorRanks !== null && anchorKey !== null) {
    for (let field = 0; field < columns.length; field++) {
      const value = anchorKey[field] ?? null
      anchorStore.set(field, value)
      anchorRanks[field] = rankOfValue(columns[field].order, value)
    }
  }
  const anchor = anchorStore?.regions(columns.length) ?? null
  const capacity = state.docStore.count()
  const output = new Uint32Array(capacity)
  const resolver = state.docStore.resolver()
  let requested = Math.min(limit, capacity)
  for (;;) {
    const count = sortSelect(regions, orders, filter, live, requested, anchorRanks, anchor, output)
    if (count < 0) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The sorted page could not be selected', { status: -count })
    }
    const page: SortedPageEntry[] = []
    for (let at = 0; at < count; at++) {
      const ordinal = output[at]
      const id = resolver.toExternal(ordinal)
      if (id === undefined) continue
      const key = columns.map(column => column.valueOf(ordinal))
      if (anchorKey !== null && anchorId !== null) {
        const order = compareComparableKeys(key, anchorKey, directions)
        if (order < 0 || (order === 0 && compareCodePoints(id, anchorId) <= 0)) continue
      }
      page.push({ id, key })
    }
    page.sort(
      (left, right) => compareComparableKeys(left.key, right.key, directions) || compareCodePoints(left.id, right.id),
    )
    if (page.length >= limit || count < requested || requested === capacity) return page.slice(0, limit)
    requested = Math.min(capacity, Math.max(requested * 2, requested + limit - page.length))
  }
}
