import { fnv1aBytes } from '../core/hash'
import { compareCodePoints } from '../core/ordering'
import type { FilterExpression } from '../types/filters'
import type { QueryParams } from '../types/search'

const ABSENT_TAG = 0
const NULL_TAG = 1
const FALSE_TAG = 2
const TRUE_TAG = 3
const NUMBER_TAG = 4
const STRING_TAG = 5
const LIST_TAG = 6
const MAP_TAG = 7

const encoder = new TextEncoder()

interface BindingStream {
  bytes: Uint8Array
  length: number
}

function ensureCapacity(stream: BindingStream, extra: number): void {
  if (stream.length + extra <= stream.bytes.length) return
  const grown = new Uint8Array(Math.max(stream.bytes.length * 2, stream.length + extra))
  grown.set(stream.bytes.subarray(0, stream.length))
  stream.bytes = grown
}

function writeByte(stream: BindingStream, value: number): void {
  ensureCapacity(stream, 1)
  stream.bytes[stream.length] = value
  stream.length += 1
}

function writeUint32(stream: BindingStream, value: number): void {
  ensureCapacity(stream, 4)
  stream.bytes[stream.length] = (value >>> 24) & 0xff
  stream.bytes[stream.length + 1] = (value >>> 16) & 0xff
  stream.bytes[stream.length + 2] = (value >>> 8) & 0xff
  stream.bytes[stream.length + 3] = value & 0xff
  stream.length += 4
}

const numberBytes = new DataView(new ArrayBuffer(8))

function writeNumber(stream: BindingStream, value: number): void {
  numberBytes.setFloat64(0, value, false)
  ensureCapacity(stream, 8)
  for (let i = 0; i < 8; i++) {
    stream.bytes[stream.length + i] = numberBytes.getUint8(i)
  }
  stream.length += 8
}

function writeString(stream: BindingStream, value: string): void {
  const encoded = encoder.encode(value)
  writeUint32(stream, encoded.length)
  ensureCapacity(stream, encoded.length)
  stream.bytes.set(encoded, stream.length)
  stream.length += encoded.length
}

function writeValue(stream: BindingStream, value: unknown): void {
  if (value === undefined) {
    writeByte(stream, ABSENT_TAG)
    return
  }
  if (value === null) {
    writeByte(stream, NULL_TAG)
    return
  }
  if (typeof value === 'boolean') {
    writeByte(stream, value ? TRUE_TAG : FALSE_TAG)
    return
  }
  if (typeof value === 'number') {
    writeByte(stream, NUMBER_TAG)
    writeNumber(stream, value)
    return
  }
  if (typeof value === 'string') {
    writeByte(stream, STRING_TAG)
    writeString(stream, value)
    return
  }
  if (Array.isArray(value)) {
    writeByte(stream, LIST_TAG)
    writeUint32(stream, value.length)
    for (const member of value) {
      writeValue(stream, member ?? null)
    }
    return
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort(compareCodePoints)
  writeByte(stream, MAP_TAG)
  writeUint32(stream, keys.length)
  for (const key of keys) {
    writeByte(stream, STRING_TAG)
    writeString(stream, key)
    writeValue(stream, record[key] ?? null)
  }
}

function boundVectorOf(vector: QueryParams['vector']): Record<string, unknown> | undefined {
  if (vector === undefined) return undefined
  const bound: Record<string, unknown> = { ...vector }
  if (vector.value !== undefined) {
    bound.value = Array.from(vector.value, Math.fround)
  }
  if (vector.text !== undefined) {
    delete bound.value
  }
  return bound
}

const FILTERS_SLOT = 2
const BOUND_SLOT_COUNT = 14

function bindingOf(values: unknown[]): string {
  const stream: BindingStream = { bytes: new Uint8Array(256), length: 0 }
  for (const value of values) {
    writeValue(stream, value)
  }
  return fnv1aBytes(stream.bytes.subarray(0, stream.length)).toString(16).padStart(8, '0')
}

/**
 * Computes the cursor binding of a search request: the FNV-1a hash, as eight
 * lowercase hex digits, over the values that decide which documents a page
 * holds. A reader recomputes it and rejects a cursor whose binding differs, so
 * a cursor pages only the request that produced it. The specification's
 * cursor-binding section fixes the value order and the byte encoding.
 */
export function queryBindingOf(params: QueryParams): string {
  return bindingOf([
    params.term,
    params.fields,
    params.filters,
    params.boost,
    params.minScore,
    params.termMatch,
    params.tolerance,
    params.prefixLength,
    params.prefix,
    params.exact,
    params.pinned,
    params.mode,
    params.hybrid,
    boundVectorOf(params.vector),
  ])
}

/**
 * Computes the cursor binding of a listing request, which binds its filters
 * alone, with every other bound value absent.
 */
export function listBindingOf(filters: FilterExpression | undefined): string {
  const values = new Array<unknown>(BOUND_SLOT_COUNT).fill(undefined)
  values[FILTERS_SLOT] = filters
  return bindingOf(values)
}
