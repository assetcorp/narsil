import { type ComparableSortValue, readSortField, toComparableSortValue } from '../ordering'
import { createSortColumnSet } from './sort-columns'
import { type SortedPageEntry, type SortPageRequest, selectSortedPage } from './sort-columns/select'
import type { PartitionReadState } from './utils'

export type { SortedPageEntry, SortPageRequest } from './sort-columns/select'

function ensureColumns(state: PartitionReadState): void {
  if (state.sortColumns === null) {
    state.sortColumns = createSortColumnSet(state.docStore)
  }
}

export function sortedPageOf(state: PartitionReadState, request: SortPageRequest): SortedPageEntry[] {
  ensureColumns(state)
  return selectSortedPage(state, request)
}

export function sortValuesOf(
  state: PartitionReadState,
  docId: string,
  fields: readonly string[],
  fieldTypes: readonly (string | undefined)[],
): ComparableSortValue[] {
  const set = state.sortColumns
  const internalId = state.docStore.getInternalId(docId)
  const stored = state.docStore.get(docId)
  const key: ComparableSortValue[] = new Array(fields.length)

  for (let i = 0; i < fields.length; i++) {
    if (set !== null && internalId !== undefined && set.holds(fields[i])) {
      key[i] = set.column(fields[i], fieldTypes[i]).valueOf(internalId)
      continue
    }
    key[i] = stored === undefined ? null : toComparableSortValue(readSortField(stored.fields, fields[i]))
  }

  return key
}

export function recordSortValues(
  state: PartitionReadState,
  internalId: number,
  document: Record<string, unknown>,
): void {
  state.sortColumns?.record(internalId, document)
}

export function forgetSortValues(state: PartitionReadState, internalId: number | undefined): void {
  if (internalId === undefined) return
  state.sortColumns?.forget(internalId)
}

export function refreshSortColumns(state: PartitionReadState): void {
  state.sortColumns?.refresh()
}

export function sortColumnBytes(state: PartitionReadState): number {
  return state.sortColumns === null ? 0 : state.sortColumns.estimateBytes()
}
