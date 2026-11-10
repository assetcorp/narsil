import { regionsOverlap, typedRegion } from '../../engine/optional-reads-host-bindings'
import type { NativeSortCore } from '../../vector/native/types/sort'
import { compareComparableValues } from '../ordering/sort-comparison'
import { captureSortValues, readSortRegions, sortValueAt, validSortValue } from './regions'

export const buildSortOrder: NativeSortCore['buildSortOrder'] = (
  currentInput,
  liveInput,
  valuesInput,
  ranksInput,
  orderedInput,
  dirtyInput,
  countsInput,
) => {
  const currentHeld = captureSortValues(currentInput)
  const valuesHeld = captureSortValues(valuesInput)
  const current = readSortRegions(currentHeld)
  const values = readSortRegions(valuesHeld)
  const live = typedRegion(liveInput, 'Uint32Array')
  const ranks = typedRegion(ranksInput, 'Int32Array')
  const ordered = typedRegion(orderedInput, 'Uint32Array')
  const dirty = typedRegion(dirtyInput, 'Uint32Array')
  const counts = typedRegion(countsInput, 'Uint32Array')
  if (
    current === null ||
    values === null ||
    live === null ||
    ranks === null ||
    ordered === null ||
    dirty === null ||
    counts === null
  )
    return -1
  const count = current.kinds.length
  if (
    count > 0xffffffff ||
    current.numbers.length !== count ||
    current.textStart.length !== count ||
    current.textLength.length !== count ||
    current.units.length > 0xffffffff
  )
    return -1
  const words = Math.max(1, Math.ceil(count / 32))
  if (live.length < words) return -1
  const inputs = [...Object.values(current), live]
  const outputs = [...Object.values(values), ranks, ordered, dirty, counts]
  for (let target = 0; target < outputs.length; target++) {
    for (const input of inputs) if (regionsOverlap(outputs[target], input)) return -1
    for (let prior = 0; prior < target; prior++) if (regionsOverlap(outputs[target], outputs[prior])) return -1
  }
  const present: number[] = []
  for (let ordinal = 0; ordinal < count; ordinal++) {
    if ((live[ordinal >>> 5] & (1 << (ordinal & 31))) === 0) continue
    if (!validSortValue(current, ordinal)) return -1
    if (current.kinds[ordinal] !== 0) present.push(ordinal)
  }
  if (ranks.length < count || ordered.length < present.length || dirty.length < words || counts.length < 2) return -3
  const comparable = new Map(present.map(ordinal => [ordinal, sortValueAt(current, ordinal)]))
  const compare = (left: number, right: number): number =>
    compareComparableValues(comparable.get(left) ?? null, comparable.get(right) ?? null, 'asc')
  present.sort(compare)
  const distinct: number[] = []
  let units = 0
  for (let at = 0; at < present.length; at++) {
    const ordinal = present[at]
    if (at > 0 && compare(present[at - 1], ordinal) === 0) continue
    distinct.push(ordinal)
    if (current.kinds[ordinal] === 2) units += current.textLength[ordinal]
  }
  if (distinct.length > 0x3fffffff || units > 0xffffffff) return -1
  if (
    distinct.length > values.kinds.length ||
    distinct.length > values.numbers.length ||
    distinct.length > values.textStart.length ||
    distinct.length > values.textLength.length ||
    units > values.units.length
  )
    return -3
  ranks.fill(-1, 0, count)
  let unique = 0
  let unit = 0
  for (let at = 0; at < present.length; at++) {
    const ordinal = present[at]
    if (at === 0 || compare(present[at - 1], ordinal) !== 0) {
      const kind = current.kinds[ordinal]
      values.kinds[unique] = kind
      values.numbers[unique] = 0
      values.textStart[unique] = 0
      values.textLength[unique] = 0
      if (kind === 1) values.numbers[unique] = current.numbers[ordinal] === 0 ? 0 : current.numbers[ordinal]
      else if (kind === 2) {
        const start = current.textStart[ordinal]
        const length = current.textLength[ordinal]
        values.textStart[unique] = unit
        values.textLength[unique] = length
        values.units.set(current.units.subarray(start, start + length), unit)
        unit += length
      }
      unique++
    }
    ranks[ordinal] = unique * 2
    ordered[at] = ordinal
  }
  dirty.fill(0, 0, words)
  counts[0] = unique
  counts[1] = present.length
  return 0
}
