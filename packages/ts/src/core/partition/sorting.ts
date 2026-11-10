import { sortFacetedNumbers } from '../../search/facets'
import {
  createSortColumnSet,
  reduceStoredSortValue,
  selectSortedPage,
  selectTextRange,
} from '../../search/sorting-code'
import type { SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { type ComparableSortValue, defaultSortMode, type SortMode } from '../ordering'
import { storedValuesOf } from '../stored-values/columns'
import type { PartitionIndex } from './partition-index'
import type { SortColumnSet } from './sort-columns'
import type { TextRangeBounds } from './sort-columns/range'
import type { SortedPageEntry, SortPageRequest } from './sort-columns/select'
import type { PartitionReadState, PartitionState } from './utils'

export type { SortedPageEntry, SortPageRequest } from './sort-columns/select'

function ensureColumns(state: PartitionReadState): SortColumnSet {
  if (state.sortColumns === null) {
    state.sortColumns = createSortColumnSet(state.docStore)
  }
  return state.sortColumns
}

export function textRangeBitsetOf(
  state: PartitionReadState,
  fieldPath: string,
  fieldType: string | undefined,
  bounds: TextRangeBounds,
  capacity: number,
): Uint32Array {
  const columns = ensureColumns(state)
  const column = columns.column(fieldPath, fieldType, 'min')
  return selectTextRange(column, bounds, capacity, columns.liveBitset())
}

export type SortColumnsRequest = Pick<SortPageRequest, 'fields' | 'directions' | 'fieldTypes' | 'modes'>

export function prepareSortColumnsOf(state: PartitionReadState, request: SortColumnsRequest): void {
  const set = ensureColumns(state)
  const { fields, directions, fieldTypes, modes } = request
  for (let index = 0; index < fields.length; index++) {
    set.column(fields[index], fieldTypes[index], modes[index] ?? defaultSortMode(directions[index] ?? 'asc'))
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
  modes: readonly SortMode[],
): ComparableSortValue[] {
  const set = state.sortColumns
  const internalId = state.docStore.getInternalId(docId)
  const key: ComparableSortValue[] = new Array(fields.length)

  for (let i = 0; i < fields.length; i++) {
    const mode = modes[i] ?? 'min'
    if (internalId === undefined) {
      key[i] = null
      continue
    }
    if (set?.holds(fields[i], fieldTypes[i], mode)) {
      key[i] = set.column(fields[i], fieldTypes[i], mode).valueOf(internalId)
      continue
    }
    key[i] = reduceStoredSortValue(storedValuesOf(state.docStore, fields[i]), internalId, mode)
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

export function sortedReadsOf(
  state: PartitionState,
): Pick<PartitionIndex, 'prepareSortedPage' | 'prepareFacets' | 'sortedPage' | 'sortValues'> {
  return {
    prepareSortedPage(request: SortColumnsRequest): void {
      prepareSortColumnsOf(state, request)
    },
    prepareFacets(config: FacetConfig, schema: SchemaDefinition): void {
      sortFacetedNumbers(state, config, schema)
    },
    sortedPage(request: SortPageRequest): SortedPageEntry[] {
      return sortedPageOf(state, request)
    },
    sortValues(docId, fields, fieldTypes, modes): ComparableSortValue[] {
      return sortValuesOf(state, docId, fields, fieldTypes, modes)
    },
  }
}
