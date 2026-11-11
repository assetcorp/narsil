export interface RegionTypes {
  Uint8Array: Uint8Array
  Uint16Array: Uint16Array
  Uint32Array: Uint32Array
  Int32Array: Int32Array
  Float64Array: Float64Array
  BigUint64Array: BigUint64Array
  BigInt64Array: BigInt64Array
}

const views = {
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int32Array,
  Float64Array,
  BigUint64Array,
  BigInt64Array,
}
const prototype: object = Object.getPrototypeOf(Uint8Array.prototype)
const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)?.get
const bufferOf = Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get
const offsetOf = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')?.get
const lengthOf = Object.getOwnPropertyDescriptor(prototype, 'length')?.get

export function regionLength(value: unknown): number | null {
  if (!ArrayBuffer.isView(value)) return null
  try {
    const length: unknown = lengthOf?.call(value)
    return typeof length === 'number' ? length : null
  } catch {
    return null
  }
}

export function typedRegion<K extends keyof RegionTypes>(value: unknown, kind: K): RegionTypes[K] | null {
  if (!ArrayBuffer.isView(value) || tag?.call(value) !== kind) return null
  const length: unknown = lengthOf?.call(value)
  if (typeof length !== 'number') return null
  try {
    const buffer: unknown = bufferOf?.call(value)
    const offset: unknown = offsetOf?.call(value)
    if (typeof offset !== 'number' || buffer === undefined) return null
    const View: new (buffer: ArrayBufferLike, offset: number, length: number) => RegionTypes[keyof RegionTypes] =
      views[kind]
    return new View(buffer as ArrayBufferLike, offset, length) as RegionTypes[K]
  } catch {
    return null
  }
}
