import type { DocumentStore } from '../../document-store'
import { type ComparableSortValue, compareComparableValues, readSortField } from '../../ordering'
import { buildOrder, estimateOrderBytes, MISSING_RANK, rankOfValue, type SortColumnOrder, seekPosition } from './order'
import { createValueStore, kindForFieldType, type ValueStore } from './values'

export type { SortColumnOrder } from './order'
export { MISSING_RANK, rankIsBetweenValues, seekPosition } from './order'

const MINIMUM_REBUILD_THRESHOLD = 1024
const REBUILD_FRACTION_SHIFT = 2

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
  holds(field: string): boolean
  column(field: string, fieldType: string | undefined): SortColumn
  record(internalId: number, document: Record<string, unknown>): void
  forget(internalId: number): void
  refresh(): void
  fieldCount(): number
  estimateBytes(): number
}

interface ColumnEntry {
  field: string
  store: ValueStore
  order: SortColumnOrder
  dirty: Set<number>
  dirtyStream: DirtyStream | null
}

function liveInternalIds(docStore: DocumentStore): number[] {
  const ids: number[] = []
  for (const internalId of docStore.allInternalIds()) ids.push(internalId)
  return ids
}

export function createSortColumnSet(docStore: DocumentStore): SortColumnSet {
  const columns = new Map<string, ColumnEntry>()

  function rebuildThreshold(): number {
    const count = docStore.count()
    const fraction = count >> REBUILD_FRACTION_SHIFT
    return fraction > MINIMUM_REBUILD_THRESHOLD ? fraction : MINIMUM_REBUILD_THRESHOLD
  }

  function rebuild(entry: ColumnEntry): void {
    entry.order = buildOrder(entry.store, docStore.allInternalIds(), docStore.internalIdCapacity())
    entry.dirty.clear()
    entry.dirtyStream = null
  }

  function backfill(field: string, fieldType: string | undefined): ColumnEntry {
    const store = createValueStore(kindForFieldType(fieldType))
    for (const [docId, stored] of docStore.all()) {
      const internalId = docStore.getInternalId(docId)
      if (internalId === undefined) continue
      store.set(internalId, readSortField(stored.fields, field))
    }
    const entry: ColumnEntry = {
      field,
      store,
      order: buildOrder(store, liveInternalIds(docStore), docStore.internalIdCapacity()),
      dirty: new Set(),
      dirtyStream: null,
    }
    columns.set(field, entry)
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
    holds(field: string): boolean {
      return columns.has(field)
    },

    column(field: string, fieldType: string | undefined): SortColumn {
      let entry = columns.get(field)
      if (entry === undefined) {
        entry = backfill(field, fieldType)
      } else if (entry.dirty.size > rebuildThreshold()) {
        rebuild(entry)
      }
      return viewOf(entry)
    },

    record(internalId: number, document: Record<string, unknown>): void {
      for (const entry of columns.values()) {
        entry.store.set(internalId, readSortField(document, entry.field))
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
