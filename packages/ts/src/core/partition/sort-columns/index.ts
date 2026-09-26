import type { DocumentStoreReader } from '../../document-store'
import {
  type ComparableSortValue,
  compareComparableValues,
  readSortField,
  type SortMode,
  toReducedSortValue,
} from '../../ordering'
import { SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD, SORT_COLUMN_REBUILD_FRACTION_SHIFT } from '../constants'
import { buildOrder, estimateOrderBytes, MISSING_RANK, rankOfValue, type SortColumnOrder, seekPosition } from './order'
import { createValueStore, kindForFieldType, type ValueStore } from './values'

export type { SortColumnOrder } from './order'
export { MISSING_RANK, rankIsBetweenValues, seekPosition } from './order'

export interface DirtyStream {
  present: Int32Array
  missing: Int32Array
}

export interface SortColumn {
  readonly field: string
  readonly order: SortColumnOrder
  valueOf(internalId: number): ComparableSortValue
  rankOf(internalId: number): number
  isDirty(internalId: number): boolean
  dirtyStream(): DirtyStream
  seek(rank: number, direction: 'asc' | 'desc'): number
}

export interface SortColumnSet {
  holds(field: string, fieldType: string | undefined, mode: SortMode): boolean
  column(field: string, fieldType: string | undefined, mode: SortMode): SortColumn
  record(internalId: number, document: Record<string, unknown>): void
  forget(internalId: number): void
  refresh(): void
  fieldCount(): number
  estimateBytes(): number
}

interface ColumnEntry {
  field: string
  mode: SortMode
  store: ValueStore
  order: SortColumnOrder
  dirty: Set<number>
  dirtyStream: DirtyStream | null
}

function mayHoldList(fieldType: string | undefined): boolean {
  return fieldType === undefined || fieldType.endsWith('[]')
}

function columnKeyOf(field: string, fieldType: string | undefined, mode: SortMode): string {
  return mayHoldList(fieldType) ? `${mode}:${field}` : `value:${field}`
}

function liveInternalIds(docStore: DocumentStoreReader): number[] {
  const ids: number[] = []
  for (const internalId of docStore.allInternalIds()) ids.push(internalId)
  return ids
}

export function createSortColumnSet(docStore: DocumentStoreReader): SortColumnSet {
  const columns = new Map<string, ColumnEntry>()

  function rebuildThreshold(): number {
    const count = docStore.count()
    const fraction = count >> SORT_COLUMN_REBUILD_FRACTION_SHIFT
    return fraction > SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD ? fraction : SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD
  }

  function rebuild(entry: ColumnEntry): void {
    entry.order = buildOrder(entry.store, docStore.allInternalIds(), docStore.internalIdCapacity())
    entry.dirty.clear()
    entry.dirtyStream = null
  }

  function backfill(key: string, field: string, fieldType: string | undefined, mode: SortMode): ColumnEntry {
    const store = createValueStore(kindForFieldType(fieldType))
    for (const [docId, stored] of docStore.all()) {
      const internalId = docStore.getInternalId(docId)
      if (internalId === undefined) continue
      store.set(internalId, toReducedSortValue(readSortField(stored.fields, field), mode))
    }
    const entry: ColumnEntry = {
      field,
      mode,
      store,
      order: buildOrder(store, liveInternalIds(docStore), docStore.internalIdCapacity()),
      dirty: new Set(),
      dirtyStream: null,
    }
    columns.set(key, entry)
    return entry
  }

  function buildDirtyStream(entry: ColumnEntry): DirtyStream {
    const present: number[] = []
    const missing: number[] = []
    const rankById = new Map<number, number>()

    for (const internalId of entry.dirty) {
      if (docStore.getExternalId(internalId) === undefined) continue
      const value = entry.store.get(internalId)
      if (value === null) {
        missing.push(internalId)
        continue
      }
      present.push(internalId)
      rankById.set(internalId, rankOfValue(entry.order, value))
    }

    present.sort((a, b) => {
      const rankDifference = (rankById.get(a) ?? MISSING_RANK) - (rankById.get(b) ?? MISSING_RANK)
      if (rankDifference !== 0) return rankDifference
      return compareComparableValues(entry.store.get(a), entry.store.get(b), 'asc')
    })

    return { present: Int32Array.from(present), missing: Int32Array.from(missing) }
  }

  function viewOf(entry: ColumnEntry): SortColumn {
    return {
      get field() {
        return entry.field
      },
      get order() {
        return entry.order
      },
      valueOf(internalId: number): ComparableSortValue {
        return entry.store.get(internalId)
      },
      rankOf(internalId: number): number {
        if (entry.dirty.has(internalId)) return rankOfValue(entry.order, entry.store.get(internalId))
        if (internalId >= entry.order.ranks.length) return MISSING_RANK
        return entry.order.ranks[internalId]
      },
      isDirty(internalId: number): boolean {
        return entry.dirty.has(internalId)
      },
      dirtyStream(): DirtyStream {
        if (entry.dirtyStream === null) entry.dirtyStream = buildDirtyStream(entry)
        return entry.dirtyStream
      },
      seek(rank: number, direction: 'asc' | 'desc'): number {
        return seekPosition(entry.order, rank, direction)
      },
    }
  }

  return {
    holds(field: string, fieldType: string | undefined, mode: SortMode): boolean {
      return columns.has(columnKeyOf(field, fieldType, mode))
    },

    column(field: string, fieldType: string | undefined, mode: SortMode): SortColumn {
      const key = columnKeyOf(field, fieldType, mode)
      let entry = columns.get(key)
      if (entry === undefined) {
        entry = backfill(key, field, fieldType, mode)
      } else if (entry.dirty.size > rebuildThreshold()) {
        rebuild(entry)
      }
      return viewOf(entry)
    },

    record(internalId: number, document: Record<string, unknown>): void {
      for (const entry of columns.values()) {
        entry.store.set(internalId, toReducedSortValue(readSortField(document, entry.field), entry.mode))
        entry.dirty.add(internalId)
        entry.dirtyStream = null
      }
    },

    forget(internalId: number): void {
      for (const entry of columns.values()) {
        entry.store.clear(internalId)
        entry.dirty.delete(internalId)
        entry.dirtyStream = null
      }
    },

    refresh(): void {
      const threshold = rebuildThreshold()
      for (const entry of columns.values()) {
        if (entry.dirty.size > threshold) rebuild(entry)
      }
    },

    fieldCount(): number {
      return columns.size
    },

    estimateBytes(): number {
      let bytes = 0
      for (const entry of columns.values()) {
        bytes += entry.store.estimateBytes() + estimateOrderBytes(entry.order)
      }
      return bytes
    },
  }
}
