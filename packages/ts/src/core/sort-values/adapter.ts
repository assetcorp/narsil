import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeSortCore } from '../../vector/native/types/sort'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import type { ComparableSortValue, SortMode } from '../ordering/sort-values'
import { buildStoredValues } from '../stored-values/build'

const modes = { min: 0, max: 1, avg: 2, median: 3 }
const outNumber = new Float64Array(1)
const outText = new Uint32Array(2)
const scalar: NativeStoredValues = {
  shapes: new Uint8Array([1]),
  starts: new Uint32Array([0, 1]),
  kinds: new Uint8Array(1),
  numbers: new Float64Array(1),
  textStart: new Uint32Array(1),
  textLength: new Uint32Array(1),
  units: new Uint16Array(0),
  bytes: new Uint8Array(0),
}

function storedValue(value: unknown): NativeStoredValues {
  if (typeof value === 'number') {
    scalar.kinds[0] = 3
    scalar.numbers[0] = value
  } else if (typeof value === 'boolean') scalar.kinds[0] = value ? 2 : 1
  else if (value === null || value === undefined) scalar.kinds[0] = 0
  else if (typeof value === 'string') {
    if (value.length > 0x40000000) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored string exceeds the native text layout')
    }
    if (scalar.units.length < value.length) {
      scalar.units = new Uint16Array(Math.max(value.length, Math.min(0x40000000, scalar.units.length * 2)))
    }
    scalar.kinds[0] = 4
    scalar.textLength[0] = value.length
    for (let index = 0; index < value.length; index++) scalar.units[index] = value.charCodeAt(index)
  } else return buildStoredValues([value])
  return scalar
}

export function reduceWith(
  operation: NativeSortCore['sortValue'],
  value: unknown,
  mode: SortMode,
): ComparableSortValue {
  return reduceStoredWith(operation, storedValue(value), 0, mode)
}

export function reduceStoredWith(
  operation: NativeSortCore['sortValue'],
  values: NativeStoredValues,
  ordinal: number,
  mode: SortMode,
): ComparableSortValue {
  const kind = operation(values, ordinal, modes[mode], outNumber, outText)
  if (kind < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The sort value could not be reduced', { status: -kind })
  }
  if (kind === 1) return outNumber[0]
  if (kind === 2) return String.fromCharCode(...values.units.subarray(outText[0], outText[0] + outText[1]))
  if (kind === 3) return false
  if (kind === 4) return true
  return null
}
