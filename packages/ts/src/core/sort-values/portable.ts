import {
  readStoredFields,
  regionsOverlap,
  SORT_VALUE_MAX_CODE_POINTS,
  typedRegion,
  validStoredValue,
} from '../../engine/optional-reads-host-bindings'
import type { NativeSortCore } from '../../vector/native/types/sort'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import { compareSortStrings } from '../ordering/fold-compare'

function textLength(values: NativeStoredValues, index: number): number {
  const start = values.textStart[index]
  const end = start + values.textLength[index]
  let position = start
  for (let count = 0; position < end && count < SORT_VALUE_MAX_CODE_POINTS; count++) {
    const unit = values.units[position++]
    if (unit >= 0xd800 && unit < 0xdc00 && position < end) {
      const low = values.units[position]
      if (low >= 0xdc00 && low < 0xe000) position++
    }
  }
  return position - start
}

function textValue(values: NativeStoredValues, index: number): string {
  const start = values.textStart[index]
  const length = textLength(values, index)
  return String.fromCharCode(...values.units.subarray(start, start + length))
}

function kindOf(values: NativeStoredValues, index: number): number {
  const kind = values.kinds[index]
  if (kind === 3) return Number.isFinite(values.numbers[index]) ? 1 : 0
  if (kind === 4) return 2
  if (kind === 1) return 3
  if (kind === 2) return 4
  return 0
}

function compare(values: NativeStoredValues, left: number, right: number): number {
  const kind = kindOf(values, left)
  const other = kindOf(values, right)
  if (kind !== other) return kind - other
  if (kind === 1) return values.numbers[left] - values.numbers[right]
  if (kind === 2) return compareSortStrings(textValue(values, left), textValue(values, right))
  return 0
}

function reduceNumbers(values: NativeStoredValues, start: number, end: number, mode: number): number | null {
  let mean = 0
  let count = 0
  const numbers: number[] = []
  for (let position = start; position < end; position++) {
    if (kindOf(values, position) !== 1) continue
    const value = values.numbers[position]
    count++
    if (mode === 3) numbers.push(value)
    else {
      const difference = value - mean
      mean = Number.isFinite(difference) ? mean + difference / count : mean * ((count - 1) / count) + value / count
    }
  }
  if (count === 0) return null
  if (mode !== 3) return mean
  numbers.sort((left, right) => left - right)
  const middle = Math.floor(count / 2)
  return count % 2 === 1 ? numbers[middle] : numbers[middle - 1] / 2 + numbers[middle] / 2
}

export const sortValue: NativeSortCore['sortValue'] = (input, ordinal, mode, outputNumber, outputText) => {
  if (
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 0xffffffff ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 3
  )
    return -1
  const fields = readStoredFields([input])
  const outNumber = typedRegion(outputNumber, 'Float64Array')
  const outText = typedRegion(outputText, 'Uint32Array')
  const values = fields?.[0]
  if (values === undefined || outNumber === null || outText === null || ordinal >= values.shapes.length) return -1
  if (regionsOverlap(outNumber, outText)) return -1
  for (const region of Object.values(values)) {
    if (regionsOverlap(region, outNumber) || regionsOverlap(region, outText)) return -1
  }
  if (!validStoredValue(values, ordinal)) return -1
  const start = values.starts[ordinal]
  const end = values.starts[ordinal + 1]
  for (let position = start; position < end; position++) {
    if (values.kinds[position] === 4 && values.textLength[position] > 0x40000000) return -1
  }
  if (outNumber.length < 1 || outText.length < 2) return -3
  if (values.shapes[ordinal] === 2 && mode >= 2) {
    const value = reduceNumbers(values, start, end, mode)
    if (value === null) return 0
    outNumber[0] = value
    return 1
  }
  let chosen = end
  for (let position = start; position < end; position++) {
    if (kindOf(values, position) === 0) continue
    if (chosen === end) chosen = position
    else {
      const order = compare(values, position, chosen)
      if (mode === 1 ? order > 0 : order < 0) chosen = position
    }
  }
  const kind = chosen === end ? 0 : kindOf(values, chosen)
  if (kind === 1) outNumber[0] = values.numbers[chosen]
  else if (kind === 2) {
    outText[0] = values.textStart[chosen]
    outText[1] = textLength(values, chosen)
  }
  return kind
}
