import { KEYWORD_INSERTION_SORT_ROWS } from './constants'

const UNKNOWN_FIELD_RANK = 0x10000

export interface RowKeys {
  readonly docIds: ArrayLike<number>
  readonly fields: ArrayLike<number>
  readonly nameRanks: Uint16Array
}

function rankOf(keys: RowKeys, row: number): number {
  const field = keys.fields[row]
  return field < keys.nameRanks.length ? keys.nameRanks[field] : UNKNOWN_FIELD_RANK
}

function rowBefore(keys: RowKeys, left: number, right: number): boolean {
  const leftDoc = keys.docIds[left]
  const rightDoc = keys.docIds[right]
  if (leftDoc !== rightDoc) return leftDoc < rightDoc
  return rankOf(keys, left) < rankOf(keys, right)
}

function insertionSort(keys: RowKeys, order: Uint32Array, from: number, count: number): void {
  for (let at = from + 1; at < from + count; at++) {
    const row = order[at]
    let to = at
    while (to > from && rowBefore(keys, row, order[to - 1])) {
      order[to] = order[to - 1]
      to--
    }
    order[to] = row
  }
}

function mergeRuns(
  keys: RowKeys,
  source: Uint32Array,
  target: Uint32Array,
  from: number,
  middle: number,
  end: number,
): void {
  let left = from
  let right = middle
  let out = from
  while (left < middle && right < end) {
    if (rowBefore(keys, source[right], source[left])) target[out++] = source[right++]
    else target[out++] = source[left++]
  }
  while (left < middle) target[out++] = source[left++]
  while (right < end) target[out++] = source[right++]
}

export function sortRows(keys: RowKeys, order: Uint32Array, spare: Uint32Array, count: number): Uint32Array {
  if (count <= KEYWORD_INSERTION_SORT_ROWS) {
    insertionSort(keys, order, 0, count)
    return order
  }
  for (let from = 0; from < count; from += KEYWORD_INSERTION_SORT_ROWS) {
    insertionSort(keys, order, from, Math.min(KEYWORD_INSERTION_SORT_ROWS, count - from))
  }
  let source = order
  let target = spare
  for (let width = KEYWORD_INSERTION_SORT_ROWS; width < count; width *= 2) {
    for (let from = 0; from < count; from += 2 * width) {
      const middle = Math.min(from + width, count)
      const end = Math.min(from + 2 * width, count)
      mergeRuns(keys, source, target, from, middle, end)
    }
    const held = source
    source = target
    target = held
  }
  return source
}

export function ranksAscend(keys: RowKeys, start: number, count: number): boolean {
  for (let row = start + 1; row < start + count; row++) {
    if (rankOf(keys, row) < rankOf(keys, row - 1)) return false
  }
  return true
}
