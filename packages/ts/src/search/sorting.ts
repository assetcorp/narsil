import { defaultSortMode, readSortField, type SortMode, sortModeOf } from '../core/ordering'
import type { AnyDocument } from '../types/schema'
import type { SortField, SortSpec } from '../types/search'

export type { SortDirection } from '../core/ordering'

function isFieldList(sort: SortSpec): sort is readonly SortField[] {
  return Array.isArray(sort)
}

export function normalizeSort(sort: SortSpec | undefined): SortField[] {
  if (sort === undefined) return []
  if (isFieldList(sort)) {
    return sort.map(entry =>
      entry.mode === undefined
        ? { field: entry.field, direction: entry.direction }
        : { field: entry.field, direction: entry.direction, mode: entry.mode },
    )
  }
  return Object.entries(sort).map(([field, direction]) => ({ field, direction }))
}

export function sortModesOf(fields: readonly SortField[]): SortMode[] {
  return fields.map(sortModeOf)
}

export function sortSignatureEntry(entry: SortField): string[] {
  const mode = sortModeOf(entry)
  return mode === defaultSortMode(entry.direction)
    ? [entry.field, entry.direction]
    : [entry.field, entry.direction, mode]
}

export function readFieldValue(obj: AnyDocument, path: string): unknown {
  return readSortField(obj, path)
}
