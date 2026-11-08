import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import { PAYLOAD_INITIAL_CAPACITY, VALUES_INITIAL_CAPACITY } from './constants'

type Region = Uint8Array | Uint16Array | Uint32Array | Float64Array

export function checkedSize(size: number, maximum = 0xffffffff): number {
  if (!Number.isInteger(size) || size < 0 || size > maximum)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored field exceeds the native value layout')
  return size
}

function capacity(current: number, needed: number, minimum: number, maximum = 0xffffffff): number {
  checkedSize(needed, maximum)
  return Math.max(needed, Math.min(maximum, current * 2), minimum)
}

function grow<T extends Region>(
  region: T,
  needed: number,
  create: (length: number) => T,
  minimum: number,
  maximum = 0xffffffff,
): T {
  if (needed <= region.length) return region
  const next = create(capacity(region.length, needed, minimum, maximum))
  next.set(region)
  return next
}

export function reserveStoredValues(
  held: NativeStoredValues,
  ordinals: number,
  elements: number,
  units: number,
  bytes: number,
): NativeStoredValues {
  checkedSize(ordinals)
  checkedSize(elements)
  return {
    shapes: grow(held.shapes, ordinals, length => new Uint8Array(length), VALUES_INITIAL_CAPACITY),
    starts: grow(held.starts, ordinals + 1, length => new Uint32Array(length), VALUES_INITIAL_CAPACITY, 0x100000000),
    kinds: grow(held.kinds, elements, length => new Uint8Array(length), VALUES_INITIAL_CAPACITY),
    numbers: grow(held.numbers, elements, length => new Float64Array(length), VALUES_INITIAL_CAPACITY),
    textStart: grow(held.textStart, elements, length => new Uint32Array(length), VALUES_INITIAL_CAPACITY),
    textLength: grow(held.textLength, elements, length => new Uint32Array(length), VALUES_INITIAL_CAPACITY),
    units: grow(held.units, units, length => new Uint16Array(length), PAYLOAD_INITIAL_CAPACITY),
    bytes: grow(held.bytes, bytes, length => new Uint8Array(length), PAYLOAD_INITIAL_CAPACITY),
  }
}

export function compactStoredPayload(
  held: NativeStoredValues,
  elements: number,
  unitCount: number,
  byteCount: number,
  extraUnits: number,
  extraBytes: number,
): NativeStoredValues {
  const units = new Uint16Array(capacity(0, unitCount + extraUnits, PAYLOAD_INITIAL_CAPACITY))
  const bytes = new Uint8Array(capacity(0, byteCount + extraBytes, PAYLOAD_INITIAL_CAPACITY))
  const textStart = held.textStart.slice()
  let unit = 0
  let byte = 0
  for (let at = 0; at < elements; at++) {
    const start = held.textStart[at]
    const end = start + held.textLength[at]
    if (held.kinds[at] === 4) {
      units.set(held.units.subarray(start, end), unit)
      textStart[at] = unit
      unit += end - start
    } else if (held.kinds[at] === 5) {
      bytes.set(held.bytes.subarray(start, end), byte)
      textStart[at] = byte
      byte += end - start
    }
  }
  return { ...held, units, bytes, textStart }
}
