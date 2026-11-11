import type { NativeSortColumn, NativeSortValues } from '../../vector/native/types/sort'
import { compareComparableValues } from '../ordering/sort-comparison'
import { sortValueAt } from './regions'

export function marked(bits: Uint32Array, ordinal: number): boolean {
  return (bits[ordinal >>> 5] & (1 << (ordinal & 31))) !== 0
}

export function selectStart(column: NativeSortColumn, descending: number, anchor: Int32Array | null): number {
  if (anchor === null) return 0
  if (anchor[0] === -1) return column.ordered.length
  let low = 0
  let high = column.ordered.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const ordinal = column.ordered[middle]
    if (ordinal >= column.current.kinds.length || ordinal >= column.ranks.length) return -1
    const rank = column.ranks[ordinal]
    if (rank < 2 || (rank & 1) !== 0 || rank / 2 > column.values.kinds.length) return -1
    if (rank < anchor[0] || (descending !== 0 && rank === anchor[0])) low = middle + 1
    else high = middle
  }
  return descending ? column.ordered.length - low : low
}

export function columnRank(column: NativeSortColumn, ordinal: number): number {
  if (!marked(column.dirty, ordinal)) return ordinal < column.ranks.length ? column.ranks[ordinal] : -1
  const current = sortValueAt(column.current, ordinal)
  if (current === null) return -1
  let low = 0
  let high = column.values.kinds.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const order = compareComparableValues(sortValueAt(column.values, middle), current, 'asc')
    if (order === 0) return (middle + 1) * 2
    if (order < 0) low = middle + 1
    else high = middle
  }
  return low * 2 + 1
}

function compareRanks(left: number, right: number, descending: number): number {
  if (left === right) return 0
  if (left === -1) return 1
  if (right === -1) return -1
  const order = left < right ? -1 : 1
  return descending ? -order : order
}

export function selectOrder(columns: readonly NativeSortColumn[], directions: Uint8Array) {
  function compare(left: number, right: number): number {
    for (let field = 0; field < columns.length; field++) {
      const column = columns[field]
      const rank = columnRank(column, left)
      const order = compareRanks(rank, columnRank(column, right), directions[field])
      if (order !== 0) return order
      if (rank !== -1 && (rank & 1) !== 0) {
        const valueOrder = compareComparableValues(
          sortValueAt(column.current, left),
          sortValueAt(column.current, right),
          directions[field] ? 'desc' : 'asc',
        )
        if (valueOrder !== 0) return valueOrder
      }
    }
    return 0
  }

  function compareAnchor(ordinal: number, ranks: Int32Array | null, values: NativeSortValues | null): number {
    if (ranks === null || values === null) return 0
    for (let field = 0; field < columns.length; field++) {
      const column = columns[field]
      const rank = columnRank(column, ordinal)
      const order = compareRanks(rank, ranks[field], directions[field])
      if (order !== 0) return order
      if (rank !== -1 && (rank & 1) !== 0) {
        const valueOrder = compareComparableValues(
          sortValueAt(column.current, ordinal),
          sortValueAt(values, field),
          directions[field] ? 'desc' : 'asc',
        )
        if (valueOrder !== 0) return valueOrder
      }
    }
    return 0
  }
  return { compare, compareAnchor }
}
