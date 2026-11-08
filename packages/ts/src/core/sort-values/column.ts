import { typedRegion } from '../../engine/optional-reads-host-bindings'
import type { NativeSortColumn, NativeSortValues } from '../../vector/native/types/sort'
import { captureSortValues, readSortRegions } from './regions'

export function captureColumn(column: NativeSortColumn) {
  if (column === null || typeof column !== 'object') return null
  return {
    current: captureSortValues(column.current),
    values: captureSortValues(column.values),
    ranks: column.ranks,
    ordered: column.ordered,
    dirty: column.dirty,
  }
}

export function validSortShape(values: NativeSortValues): boolean {
  const count = values.kinds.length
  return (
    count <= 0xffffffff &&
    values.numbers.length === count &&
    values.textStart.length === count &&
    values.textLength.length === count &&
    values.units.length <= 0xffffffff
  )
}

export function readColumn(held: ReturnType<typeof captureColumn>): NativeSortColumn | null {
  if (held === null) return null
  const current = readSortRegions(held.current)
  const values = readSortRegions(held.values)
  const ranks = typedRegion(held.ranks, 'Int32Array')
  const ordered = typedRegion(held.ordered, 'Uint32Array')
  const dirty = typedRegion(held.dirty, 'Uint32Array')
  if (current === null || values === null || ranks === null || ordered === null || dirty === null) return null
  return { current, values, ranks, ordered, dirty }
}
