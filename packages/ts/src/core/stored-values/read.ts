import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import { typedRegion } from './regions'

function readStoredValues(value: NativeStoredValues): NativeStoredValues | null {
  if (value === null || typeof value !== 'object') return null
  const shapes = typedRegion(value.shapes, 'Uint8Array')
  const starts = typedRegion(value.starts, 'Uint32Array')
  const kinds = typedRegion(value.kinds, 'Uint8Array')
  const numbers = typedRegion(value.numbers, 'Float64Array')
  const textStart = typedRegion(value.textStart, 'Uint32Array')
  const textLength = typedRegion(value.textLength, 'Uint32Array')
  const units = typedRegion(value.units, 'Uint16Array')
  const bytes = typedRegion(value.bytes, 'Uint8Array')
  if (
    shapes === null ||
    starts === null ||
    kinds === null ||
    numbers === null ||
    textStart === null ||
    textLength === null ||
    units === null ||
    bytes === null ||
    starts.length !== shapes.length + 1 ||
    numbers.length !== kinds.length ||
    textStart.length !== kinds.length ||
    textLength.length !== kinds.length ||
    shapes.length > 0xffffffff ||
    kinds.length > 0xffffffff ||
    units.length > 0xffffffff ||
    bytes.length > 0xffffffff
  )
    return null
  return { shapes, starts, kinds, numbers, textStart, textLength, units, bytes }
}

export function readStoredFields(values: readonly NativeStoredValues[]): NativeStoredValues[] | null {
  if (!Array.isArray(values) || values.length > 0xffffffff) return null
  const descriptors: NativeStoredValues[] = []
  for (const value of values) {
    if (value === null || typeof value !== 'object') return null
    descriptors.push({
      shapes: value.shapes,
      starts: value.starts,
      kinds: value.kinds,
      numbers: value.numbers,
      textStart: value.textStart,
      textLength: value.textLength,
      units: value.units,
      bytes: value.bytes,
    })
  }
  const fields: NativeStoredValues[] = []
  for (const descriptor of descriptors) {
    const field = readStoredValues(descriptor)
    if (field === null) return null
    fields.push(field)
  }
  return fields
}

export function validStoredValue(values: NativeStoredValues, ordinal: number): boolean {
  if (ordinal >= values.shapes.length) return false
  const shape = values.shapes[ordinal]
  const start = values.starts[ordinal]
  const end = values.starts[ordinal + 1]
  if (
    shape > 2 ||
    start > end ||
    end > values.kinds.length ||
    (shape === 0 && start !== end) ||
    (shape === 1 && end - start !== 1)
  )
    return false
  for (let at = start; at < end; at++) {
    const kind = values.kinds[at]
    if (kind > 5) return false
    if (kind === 4 || kind === 5) {
      const capacity = kind === 4 ? values.units.length : values.bytes.length
      const offset = values.textStart[at]
      if (offset > capacity || values.textLength[at] > capacity - offset) return false
    }
  }
  return true
}
