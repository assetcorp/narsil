import { regionsOverlap, typedRegion } from '../../engine/optional-reads-host-bindings'
import type { NativeSortColumn, NativeSortCore } from '../../vector/native/types/sort'
import { captureColumn, readColumn, validSortShape } from './column'
import { captureSortValues, readSortRegions, validSortValue } from './regions'
import { marked, selectOrder, selectStart } from './select-order'

function validOrdinal(columns: readonly NativeSortColumn[], ordinal: number): boolean {
  for (const column of columns) {
    if (ordinal >= column.current.kinds.length || !validSortValue(column.current, ordinal)) return false
    if (marked(column.dirty, ordinal) || ordinal >= column.ranks.length) continue
    const rank = column.ranks[ordinal]
    if (rank !== -1 && (rank < 2 || (rank & 1) !== 0 || rank / 2 > column.values.kinds.length)) return false
  }
  return true
}

export const sortSelect: NativeSortCore['sortSelect'] = (
  columnsInput,
  directionsInput,
  filterInput,
  liveInput,
  limit,
  anchorRanksInput,
  anchorValuesInput,
  outputInput,
) => {
  if (
    !Array.isArray(columnsInput) ||
    columnsInput.length === 0 ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > 0xffffffff
  )
    return -1
  const columnCount = columnsInput.length
  const held: Array<ReturnType<typeof captureColumn>> = []
  for (let field = 0; field < columnCount; field++) held.push(captureColumn(columnsInput[field]))
  const anchorHeld = anchorValuesInput === null ? null : captureSortValues(anchorValuesInput)
  const columns: NativeSortColumn[] = []
  for (const entry of held) {
    const column = readColumn(entry)
    if (column === null) return -1
    columns.push(column)
  }
  const anchor = readSortRegions(anchorHeld)
  const anchorRanks = anchorRanksInput === null ? null : typedRegion(anchorRanksInput, 'Int32Array')
  const directions = typedRegion(directionsInput, 'Uint8Array')
  const filter = typedRegion(filterInput, 'Uint32Array')
  const live = typedRegion(liveInput, 'Uint32Array')
  const output = typedRegion(outputInput, 'Uint32Array')
  if (
    directions === null ||
    filter === null ||
    live === null ||
    output === null ||
    directions.length !== columns.length ||
    (anchor === null && anchorValuesInput !== null) ||
    (anchorRanks === null && anchorRanksInput !== null) ||
    (anchor === null) !== (anchorRanks === null)
  )
    return -1
  const capacity = columns[0].current.kinds.length
  const words = Math.max(1, Math.ceil(capacity / 32))
  if (
    filter.length < words ||
    live.length < words ||
    [filter, live, directions].some(input => regionsOverlap(input, output))
  )
    return -1
  if (anchor !== null && anchorRanks !== null) {
    if (
      !validSortShape(anchor) ||
      anchor.kinds.length !== columns.length ||
      anchorRanks.length !== columns.length ||
      [...Object.values(anchor), anchorRanks].some(input => regionsOverlap(input, output))
    )
      return -1
  }
  for (let field = 0; field < columns.length; field++) {
    const column = columns[field]
    if (
      !validSortShape(column.current) ||
      !validSortShape(column.values) ||
      column.current.kinds.length !== capacity ||
      column.values.kinds.length > 0x3fffffff ||
      column.ranks.length > capacity ||
      column.ordered.length > capacity ||
      column.dirty.length < words ||
      directions[field] > 1
    )
      return -1
    const regions = [
      ...Object.values(column.current),
      ...Object.values(column.values),
      column.ranks,
      column.ordered,
      column.dirty,
    ]
    if (regions.some(input => regionsOverlap(input, output))) return -1
    for (let value = 0; value < column.values.kinds.length; value++) {
      if (!validSortValue(column.values, value) || column.values.kinds[value] === 0) return -1
    }
    if (anchor !== null && anchorRanks !== null) {
      const rank = anchorRanks[field]
      if (!validSortValue(anchor, field) || rank < -1 || rank === 0 || rank > column.values.kinds.length * 2 + 1)
        return -1
    }
  }
  if (limit === 0 || capacity === 0) return 0
  const { compare, compareAnchor } = selectOrder(columns, directions)
  const selected: number[] = []
  const leading = columns[0]
  const append = (ordinal: number): boolean => {
    if (!marked(live, ordinal) || !marked(filter, ordinal)) return true
    if (!validOrdinal(columns, ordinal)) return false
    if (compareAnchor(ordinal, anchorRanks, anchor) >= 0) {
      if (selected.length >= capacity) return false
      selected.push(ordinal)
    }
    return true
  }
  for (let word = 0; word < words; word++) {
    let pending = leading.dirty[word] & live[word] & filter[word]
    while (pending !== 0) {
      const ordinal = word * 32 + (31 - Math.clz32(pending & -pending))
      pending &= pending - 1
      if (ordinal < capacity && !append(ordinal)) return -1
    }
  }
  let clean = 0
  let lastRank = -1
  const start = selectStart(leading, directions[0], anchorRanks)
  if (start < 0) return -1
  for (let at = start; at < leading.ordered.length; at++) {
    const ordinal = leading.ordered[directions[0] ? leading.ordered.length - at - 1 : at]
    if (ordinal >= capacity || ordinal >= leading.ranks.length) return -1
    if (marked(leading.dirty, ordinal) || !marked(live, ordinal) || !marked(filter, ordinal)) continue
    const rank = leading.ranks[ordinal]
    if (rank < 2 || (rank & 1) !== 0 || rank / 2 > leading.values.kinds.length) return -1
    if (clean >= limit && rank !== lastRank) break
    const before = selected.length
    if (!append(ordinal)) return -1
    if (selected.length !== before) {
      clean++
      lastRank = rank
    }
  }
  if (clean < limit) {
    for (let word = 0; word < words; word++) {
      let pending = live[word] & filter[word] & ~leading.dirty[word]
      while (pending !== 0) {
        const ordinal = word * 32 + (31 - Math.clz32(pending & -pending))
        pending &= pending - 1
        if (ordinal >= capacity || (ordinal < leading.ranks.length && leading.ranks[ordinal] !== -1)) continue
        if (!append(ordinal)) return -1
      }
    }
  }
  selected.sort(compare)
  let kept = Math.min(limit, selected.length)
  while (kept < selected.length && compare(selected[kept - 1], selected[kept]) === 0) kept++
  if (kept > output.length) return -3
  for (let at = 0; at < kept; at++) output[at] = selected[at]
  return kept
}
