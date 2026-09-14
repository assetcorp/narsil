import { ErrorCodes, NarsilError } from '../../errors'

/**
 * This buffer grows in place, so a typed array built over it without an
 * explicit length reports the new length after every growth, on every thread
 * that holds it.
 *
 * @internal
 */
export type GrowableBuffer = SharedArrayBuffer | ArrayBuffer

export function sharedMemoryAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function'
}

export function createGrowableBuffer(initialBytes: number, maxBytes: number): GrowableBuffer {
  const initial = Math.min(initialBytes, maxBytes)
  if (sharedMemoryAvailable()) {
    return new SharedArrayBuffer(initial, { maxByteLength: maxBytes })
  }
  return new ArrayBuffer(initial, { maxByteLength: maxBytes })
}

export function createFixedBuffer(bytes: number): GrowableBuffer {
  return sharedMemoryAvailable() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
}

export function nextGrowthTarget(have: number, needed: number, max: number): number {
  return Math.min(max, Math.max(needed, have * 2))
}

export function growBufferTo(buffer: GrowableBuffer, bytes: number): void {
  if (buffer.byteLength >= bytes) return
  if (bytes > buffer.maxByteLength) {
    throw new NarsilError(
      ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      `A vector structure needs ${bytes} bytes where it may hold at most ${buffer.maxByteLength}`,
      { bytes, maxBytes: buffer.maxByteLength },
    )
  }
  const target = nextGrowthTarget(buffer.byteLength, bytes, buffer.maxByteLength)
  if (buffer instanceof ArrayBuffer) {
    buffer.resize(target)
    return
  }
  try {
    buffer.grow(target)
  } catch (err) {
    if (buffer.byteLength < bytes) throw err
  }
}

interface FixedViewConstructor<View> {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): View
  readonly BYTES_PER_ELEMENT: number
}

export function fixedView<View>(buffer: GrowableBuffer, kind: FixedViewConstructor<View>): View {
  return new kind(buffer, 0, Math.floor(buffer.byteLength / kind.BYTES_PER_ELEMENT))
}
