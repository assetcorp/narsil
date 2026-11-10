import { matchGeoRegions } from '../../geo/geo-code'
import { bitsetAndInto, bitsetOrInto, bitsetSet } from '../bitset'
import type { FilterField } from './fields'
import * as L from './layout'

function numberBound(values: Float64Array, value: number, upper: boolean): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (upper ? values[middle] <= value : values[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

function numericTest(
  field: Extract<FilterField, { kind: 1 }>,
  operator: number,
  number: number,
  second: number,
  into: Uint32Array,
): void {
  const lower = () => numberBound(field.values, number, false)
  const upper = () => numberBound(field.values, number, true)
  const start = operator === L.FILTER_LT || operator === L.FILTER_LTE ? 0 : operator === L.FILTER_GT ? upper() : lower()
  const end =
    operator === L.FILTER_GT || operator === L.FILTER_GTE
      ? field.values.length
      : operator === L.FILTER_LT
        ? lower()
        : operator === L.FILTER_BETWEEN
          ? numberBound(field.values, second, true)
          : upper()
  for (let at = start; at < end; at++) bitsetSet(into, field.ordinals[at])
}

function enumTest(
  field: Extract<FilterField, { kind: 3 }>,
  operator: number,
  text: Uint16Array,
  into: Uint32Array,
): void {
  const suffix = operator === L.FILTER_SUFFIX
  const prefix = operator === L.FILTER_PREFIX || suffix
  const count = field.offsets.length - 1
  function compare(position: number): number {
    const index = suffix ? field.suffixOrder[position] : position
    if (index >= count) return -1
    const start = field.offsets[index]
    const end = field.offsets[index + 1]
    if (start > end || end > field.units.length || end - start > 0x40000000) return -1
    for (let at = 0; at < Math.min(text.length, end - start); at++) {
      const difference = field.units[suffix ? end - at - 1 : start + at] - text[suffix ? text.length - at - 1 : at]
      if (difference !== 0) return difference
    }
    return prefix && end - start >= text.length ? 0 : end - start - text.length
  }
  let low = 0
  let high = count
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (compare(middle) < 0) low = middle + 1
    else high = middle
  }
  for (let at = low; at < count && compare(at) === 0; at++) {
    const index = suffix ? field.suffixOrder[at] : at
    const start = field.postingOffsets[index]
    const end = field.postingOffsets[index + 1]
    if (start > end || end > field.postings.length) continue
    for (let entry = start; entry < end; entry++) bitsetSet(into, field.postings[entry])
  }
}

function equalTest(
  program: L.FilterProgram,
  field: FilterField,
  operator: number,
  operand: number,
  into: Uint32Array,
): void {
  if (field.kind === L.FILTER_NUMERIC)
    numericTest(field, operator, program.numbers[operand], program.numbers[operand + 1], into)
  else if (field.kind === L.FILTER_BOOLEAN)
    bitsetOrInto(into, program.numbers[operand] === 1 ? field.trueBits : field.falseBits)
  else if (field.kind === L.FILTER_ENUM)
    enumTest(field, operator, program.units.subarray(program.offsets[operand], program.offsets[operand + 1]), into)
  else if (field.kind === L.FILTER_GEO) matchGeoRegions(field, program, operator, operand, into)
}

export function filterTest(
  program: L.FilterProgram,
  field: FilterField,
  operator: number,
  operand: number,
  into: Uint32Array,
  scratch: Uint32Array,
): void {
  into.fill(0)
  if (operator !== L.FILTER_ANY && operator !== L.FILTER_ALL) {
    equalTest(program, field, operator, operand, into)
    return
  }
  const count = field.kind === L.FILTER_ENUM ? program.lists[operand * 2 + 1] : program.numbers[operand]
  const start = field.kind === L.FILTER_ENUM ? program.lists[operand * 2] : operand + 1
  if (operator === L.FILTER_ALL) into.set(program.live)
  for (let at = 0; at < count; at++) {
    if (operator === L.FILTER_ANY) equalTest(program, field, L.FILTER_EQ, start + at, into)
    else {
      scratch.fill(0)
      equalTest(program, field, L.FILTER_EQ, start + at, scratch)
      bitsetAndInto(into, scratch)
    }
  }
}
