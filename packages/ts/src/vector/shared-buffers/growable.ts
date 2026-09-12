import { ErrorCodes, NarsilError } from '../../errors'

/**
 * This buffer grows in place, so a typed array built over it without an
 * explicit length reports the new length after every growth, on every thread
 * that holds it.
 *
 * @internal
 */
export type GrowableBuffer = SharedArrayBuffer | ArrayBuffer

/**
 * Reports whether this runtime can share memory between threads.
 *
 * @returns True where `SharedArrayBuffer` exists.
 *
 * @internal
 */
export function sharedMemoryAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function'
}

/**
 * Allocates a buffer that can grow up to a ceiling without moving, shared
 * between threads where the runtime allows it.
 *
 * @param initialBytes The bytes the buffer holds at first.
 * @param maxBytes The bytes the buffer may grow to.
 * @returns The buffer.
 *
 * @internal
 */
export function createGrowableBuffer(initialBytes: number, maxBytes: number): GrowableBuffer {
  const initial = Math.min(initialBytes, maxBytes)
  if (sharedMemoryAvailable()) {
    return new SharedArrayBuffer(initial, { maxByteLength: maxBytes })
  }
  return new ArrayBuffer(initial, { maxByteLength: maxBytes })
}

/**
 * Reports the length a structure grows to, doubling what it holds so that
 * repeated growth stays cheap, and stopping at its ceiling.
 *
 * @param have The bytes it holds now.
 * @param needed The bytes it must hold afterwards.
 * @param max The bytes it may hold at most.
 * @returns The length to grow to.
 *
 * @internal
 */
export function nextGrowthTarget(have: number, needed: number, max: number): number {
  return Math.min(max, Math.max(needed, have * 2))
}

/**
 * Grows a buffer so that it holds at least the given bytes, doubling from its
 * current length so that repeated growth stays cheap.
 *
 * Two threads may grow the same shared buffer at once, and the one whose
 * request the runtime refuses as smaller than the length reached meanwhile
 * finds the buffer already large enough.
 *
 * @param buffer The buffer to grow.
 * @param bytes The bytes it must hold afterwards.
 *
 * @internal
 */
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

/**
 * Builds a view over the whole of a buffer as it stands right now, with an
 * explicit length. A view that tracks a growable buffer's length pays for a
 * synchronised length read on every element access, and that read serialises
 * the threads sharing the buffer.
 *
 * A reader keeps such a view and rebuilds it once an ordinal falls beyond its
 * length, which happens only after the buffer has grown.
 *
 * @param buffer The buffer to view.
 * @param kind The typed array constructor to build.
 * @returns The view over the buffer's current bytes.
 *
 * @internal
 */
export function fixedView<View>(buffer: GrowableBuffer, kind: FixedViewConstructor<View>): View {
  return new kind(buffer, 0, Math.floor(buffer.byteLength / kind.BYTES_PER_ELEMENT))
}
