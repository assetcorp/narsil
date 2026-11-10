import type { AnyDocument } from '../../types/schema'
import {
  ARRAY_HEADER_BYTES,
  ARRAY_SLOT_BYTES,
  NUMBER_BYTES,
  OBJECT_HEADER_BYTES,
  PRIMITIVE_SLOT_BYTES,
  PROPERTY_SLOT_BYTES,
  STRING_HEADER_BYTES,
  TWO_BYTE_SAMPLE_LIMIT,
  TYPED_ARRAY_HEADER_BYTES,
} from './constants'

type SliceableView = ArrayBufferView & { slice(begin?: number, end?: number): ArrayBufferView }

function detachedView(view: ArrayBufferView): ArrayBufferView {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view
  if (view instanceof DataView) {
    return new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }
  return (view as SliceableView).slice()
}

function sharesABiggerBuffer(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (ArrayBuffer.isView(value)) return value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (sharesABiggerBuffer(value[i])) return true
    }
    return false
  }

  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (sharesABiggerBuffer(source[key])) return true
  }
  return false
}

function withOwnBuffers(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  if (ArrayBuffer.isView(value)) return detachedView(value)

  if (Array.isArray(value)) {
    const copy = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      copy[i] = withOwnBuffers(value[i])
    }
    return copy
  }

  const source = value as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: withOwnBuffers(source[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return copy
}

/**
 * Gives a document its own memory where a field points into a buffer larger
 * than itself. Msgpack decodes a binary field as a window onto the buffer it
 * read, so a document recovered from a snapshot holds a vector that reports
 * six kilobytes and carries the whole partition behind it. Every copy of that
 * document, and every structured clone a worker boundary makes, would move the
 * partition rather than the vector, and the buffer would stay in memory for as
 * long as one document did.
 *
 * @param document - The document about to reach the store.
 * @returns The document itself where every field already owns its memory, and
 * a copy carrying loose fields otherwise.
 */
export function documentWithOwnBuffers(document: AnyDocument): AnyDocument {
  if (!sharesABiggerBuffer(document)) return document
  return withOwnBuffers(document) as AnyDocument
}

export function valueWithOwnBuffers(value: unknown): unknown {
  return sharesABiggerBuffer(value) ? withOwnBuffers(value) : value
}

function stringBytes(value: string): number {
  const sampled = Math.min(value.length, TWO_BYTE_SAMPLE_LIMIT)
  for (let i = 0; i < sampled; i += 1) {
    if (value.charCodeAt(i) > 0xff) {
      return STRING_HEADER_BYTES + value.length * 2
    }
  }
  return STRING_HEADER_BYTES + value.length
}

/**
 * Estimates the resident bytes one document value takes in the JS heap,
 * counting string content, number boxes, array slots, typed-array buffers,
 * and object properties. The live document store keeps a running total of
 * this figure, and the partition memory estimate reads that total.
 *
 * @param value - The field value, or the whole fields object, to size.
 * @returns The estimated resident bytes for the value.
 */
export function documentValueBytes(value: unknown): number {
  if (typeof value === 'string') return stringBytes(value)
  if (typeof value === 'number') return NUMBER_BYTES
  if (value === null || value === undefined || typeof value === 'boolean') return PRIMITIVE_SLOT_BYTES
  if (ArrayBuffer.isView(value)) return TYPED_ARRAY_HEADER_BYTES + value.byteLength
  if (Array.isArray(value)) {
    let bytes = ARRAY_HEADER_BYTES + value.length * ARRAY_SLOT_BYTES
    for (let i = 0; i < value.length; i += 1) {
      bytes += documentValueBytes(value[i])
    }
    return bytes
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    let bytes = OBJECT_HEADER_BYTES
    for (const key of Object.keys(source)) {
      bytes += PROPERTY_SLOT_BYTES + documentValueBytes(source[key])
    }
    return bytes
  }
  return PRIMITIVE_SLOT_BYTES
}
