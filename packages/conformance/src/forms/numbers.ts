import { FormError } from './decoded'
import { type Json, taggedNumber } from './json'

export type NumberWidth = 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'float32' | 'float64'

const BYTES_PER_VALUE: Record<NumberWidth, number> = {
  uint8: 1,
  uint16: 2,
  uint32: 4,
  uint64: 8,
  float32: 4,
  float64: 8,
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function valueAt(view: DataView, at: number, width: NumberWidth): number {
  switch (width) {
    case 'uint8':
      return view.getUint8(at)
    case 'uint16':
      return view.getUint16(at, true)
    case 'uint32':
      return view.getUint32(at, true)
    case 'uint64': {
      const value = view.getBigUint64(at, true)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormError(`a uint64 value ${value} passes 2^53 - 1`)
      return Number(value)
    }
    case 'float32':
      return view.getFloat32(at, true)
    case 'float64':
      return view.getFloat64(at, true)
  }
}

export function numbersOf(bytes: Uint8Array, width: NumberWidth, what: string): number[] {
  const size = BYTES_PER_VALUE[width]
  if (bytes.byteLength % size !== 0) throw new FormError(`${what} holds ${bytes.byteLength} bytes of ${width} values`)
  const view = viewOf(bytes)
  const values = new Array<number>(bytes.byteLength / size)
  for (let at = 0; at < values.length; at++) values[at] = valueAt(view, at * size, width)
  return values
}

export function numbersJson(bytes: Uint8Array, width: NumberWidth, what: string): Json[] {
  return numbersOf(bytes, width, what).map(taggedNumber)
}

export function numbersFromJson(values: readonly Json[], width: NumberWidth, what: string): Uint8Array {
  const size = BYTES_PER_VALUE[width]
  const bytes = new Uint8Array(values.length * size)
  const view = viewOf(bytes)
  values.forEach((entry, at) => {
    const value = numberFromJson(entry, `${what}[${at}]`)
    const offset = at * size
    switch (width) {
      case 'uint8':
        view.setUint8(offset, requireUnsigned(value, 0xff, what))
        return
      case 'uint16':
        view.setUint16(offset, requireUnsigned(value, 0xffff, what), true)
        return
      case 'uint32':
        view.setUint32(offset, requireUnsigned(value, 0xffff_ffff, what), true)
        return
      case 'uint64':
        view.setBigUint64(offset, BigInt(requireUnsigned(value, Number.MAX_SAFE_INTEGER, what)), true)
        return
      case 'float32':
        view.setFloat32(offset, value, true)
        return
      case 'float64':
        view.setFloat64(offset, value, true)
        return
    }
  })
  return bytes
}

export function numberFromJson(value: Json, what: string): number {
  if (typeof value === 'number') return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.$number === 'string') {
    if (value.$number === 'NaN') return Number.NaN
    if (value.$number === 'Infinity') return Number.POSITIVE_INFINITY
    if (value.$number === '-Infinity') return Number.NEGATIVE_INFINITY
  }
  throw new FormError(`${what} is not a number`)
}

function requireUnsigned(value: number, largest: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > largest) {
    throw new FormError(`${what} holds ${value}, outside 0 to ${largest}`)
  }
  return value
}

export function offsetsOf(bytes: Uint8Array, what: string): number[] {
  return numbersOf(bytes, 'uint32', what)
}

export function slicesOf(blob: Uint8Array, offsets: readonly number[], what: string): Uint8Array[] {
  if (offsets.length === 0 || offsets[0] !== 0 || offsets[offsets.length - 1] !== blob.byteLength) {
    throw new FormError(`${what} offsets do not span the ${blob.byteLength} bytes that they divide`)
  }
  const slices: Uint8Array[] = []
  for (let at = 0; at + 1 < offsets.length; at++) {
    if (offsets[at + 1] < offsets[at]) throw new FormError(`${what} offsets descend at entry ${at}`)
    slices.push(blob.subarray(offsets[at], offsets[at + 1]))
  }
  return slices
}

export function textsOf(blob: Uint8Array, offsets: readonly number[], what: string): string[] {
  return slicesOf(blob, offsets, what).map(slice => utf8.decode(slice))
}

export function joinedWithOffsets(parts: readonly Uint8Array[]): { blob: Uint8Array; offsets: Uint8Array } {
  const offsets = new Uint32Array(parts.length + 1)
  for (let at = 0; at < parts.length; at++) offsets[at + 1] = offsets[at] + parts[at].byteLength
  const blob = new Uint8Array(offsets[parts.length])
  parts.forEach((part, at) => {
    blob.set(part, offsets[at])
  })
  return { blob, offsets: numbersFromJson(Array.from(offsets), 'uint32', 'offsets') }
}

export function utf8Of(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
