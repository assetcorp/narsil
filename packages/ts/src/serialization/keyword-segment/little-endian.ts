const LITTLE_ENDIAN_PLATFORM = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

type TypedNumbers = Uint16Array | Uint32Array | Float64Array

function swappedCopy(values: TypedNumbers): Uint8Array {
  const width = values.BYTES_PER_ELEMENT
  const source = new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  const copy = new Uint8Array(values.byteLength)
  for (let at = 0; at < copy.length; at += width) {
    for (let k = 0; k < width; k++) copy[at + k] = source[at + width - 1 - k]
  }
  return copy
}

export function littleEndianBytes(values: TypedNumbers): Uint8Array {
  if (!LITTLE_ENDIAN_PLATFORM) return swappedCopy(values)
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
}

function allocate(byteLength: number, shared: boolean): ArrayBuffer | SharedArrayBuffer {
  return shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength)
}

function copyInto(bytes: Uint8Array, width: number, shared: boolean): ArrayBuffer | SharedArrayBuffer {
  const buffer = allocate(bytes.byteLength, shared)
  const target = new Uint8Array(buffer)
  if (LITTLE_ENDIAN_PLATFORM) {
    target.set(bytes)
    return buffer
  }
  for (let at = 0; at < bytes.length; at += width) {
    for (let k = 0; k < width; k++) target[at + k] = bytes[at + width - 1 - k]
  }
  return buffer
}

export function uint32sFrom(bytes: Uint8Array, shared: boolean): Uint32Array {
  return new Uint32Array(copyInto(bytes, 4, shared))
}

export function uint16sFrom(bytes: Uint8Array, shared: boolean): Uint16Array {
  return new Uint16Array(copyInto(bytes, 2, shared))
}

export function float64sFrom(bytes: Uint8Array, shared: boolean): Float64Array {
  return new Float64Array(copyInto(bytes, 8, shared))
}

export function bytesFrom(bytes: Uint8Array, shared: boolean): Uint8Array {
  return new Uint8Array(copyInto(bytes, 1, shared))
}
