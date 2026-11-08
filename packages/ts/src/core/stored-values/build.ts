import { ErrorCodes, NarsilError } from '../../errors'
import { requireLoadedMessagePack } from '../../serialization/msgpack-code'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'

const ORDINAL_LIMIT = 0xffffffff
const TEXT_UNIT_LIMIT = 0x40000000

function checkedCount(count: number): number {
  if (count > ORDINAL_LIMIT) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored field exceeds the native value layout')
  }
  return count
}

function valueKind(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (value === false) return 1
  if (value === true) return 2
  if (typeof value === 'number') return 3
  if (typeof value === 'string') return 4
  return 5
}

export function buildStoredValues(values: readonly unknown[]): NativeStoredValues {
  checkedCount(values.length)
  const shapes = new Uint8Array(values.length)
  const starts = new Uint32Array(values.length + 1)
  const elements: unknown[] = []
  for (let ordinal = 0; ordinal < values.length; ordinal++) {
    const value = values[ordinal]
    starts[ordinal] = elements.length
    if (value === undefined) continue
    if (Array.isArray(value)) {
      shapes[ordinal] = 2
      checkedCount(elements.length + value.length)
      for (let at = 0; at < value.length; at++) elements.push(value[at])
    } else {
      shapes[ordinal] = 1
      checkedCount(elements.length + 1)
      elements.push(value)
    }
  }
  starts[values.length] = elements.length
  const kinds = new Uint8Array(elements.length)
  const numbers = new Float64Array(elements.length)
  const textStart = new Uint32Array(elements.length)
  const textLength = new Uint32Array(elements.length)
  const encoded = new Map<number, Uint8Array>()
  let unitCount = 0
  let byteCount = 0
  for (let at = 0; at < elements.length; at++) {
    const value = elements[at]
    kinds[at] = valueKind(value)
    if (typeof value === 'number') numbers[at] = value
    else if (typeof value === 'string') {
      if (value.length > TEXT_UNIT_LIMIT) {
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored string exceeds the native text layout')
      }
      textStart[at] = unitCount
      textLength[at] = value.length
      unitCount = checkedCount(unitCount + value.length)
    } else if (kinds[at] === 5) {
      const bytes = requireLoadedMessagePack().encodeDocument(value)
      textStart[at] = byteCount
      textLength[at] = bytes.length
      byteCount = checkedCount(byteCount + bytes.length)
      encoded.set(at, bytes)
    }
  }
  const units = new Uint16Array(unitCount)
  const bytes = new Uint8Array(byteCount)
  for (let at = 0; at < elements.length; at++) {
    const value = elements[at]
    if (typeof value === 'string') {
      for (let unit = 0; unit < value.length; unit++) units[textStart[at] + unit] = value.charCodeAt(unit)
    } else {
      const stored = encoded.get(at)
      if (stored !== undefined) bytes.set(stored, textStart[at])
    }
  }
  return { shapes, starts, kinds, numbers, textStart, textLength, units, bytes }
}
