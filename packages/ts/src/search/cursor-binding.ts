import { FNV_OFFSET_BASIS, fnv1aContinue, fnv1aContinueTaggedNumbers } from '../core/hash'
import { compareCodePoints } from '../core/ordering'
import { bm25SetsValue } from '../core/scorer'
import type { SearchClock } from '../core/search-clock'
import type { FilterExpression } from '../types/filters'
import type { BM25Params } from '../types/schema'
import type { QueryParams } from '../types/search'

const ABSENT_TAG = 0
const NULL_TAG = 1
const FALSE_TAG = 2
const TRUE_TAG = 3
const NUMBER_TAG = 4
const STRING_TAG = 5
const LIST_TAG = 6
const MAP_TAG = 7

const LENGTH_BYTES = 4
const LAST_ASCII_UNIT = 0x7f

const encoder = new TextEncoder()

interface BindingStream {
  bytes: Uint8Array
  length: number
  hash: number
  clock: SearchClock | undefined
}

export type CursorBinding = () => string

function flush(stream: BindingStream): void {
  stream.hash = fnv1aContinue(stream.hash, stream.bytes, stream.length)
  stream.length = 0
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

function writeEncodedString(stream: BindingStream, value: string): void {
  const encoded = encoder.encode(value)
  writeUint32(stream, encoded.length)
  ensureCapacity(stream, encoded.length)
  stream.bytes.set(encoded, stream.length)
  stream.length += encoded.length
}

function writeString(stream: BindingStream, value: string): void {
  if (stream.clock !== undefined) stream.clock.tick(value.length)
  ensureCapacity(stream, LENGTH_BYTES + value.length)
  const start = stream.length + LENGTH_BYTES
  const bytes = stream.bytes
  for (let at = 0; at < value.length; at++) {
    const unit = value.charCodeAt(at)
    if (unit > LAST_ASCII_UNIT) {
      writeEncodedString(stream, value)
      return
    }
    bytes[start + at] = unit
  }
  writeUint32(stream, value.length)
  stream.length += value.length
}

class NumberList {
  constructor(readonly members: ArrayLike<number>) {}
}

function writeNumberList(stream: BindingStream, list: NumberList): void {
  if (stream.clock !== undefined) stream.clock.tick(list.members.length)
  writeByte(stream, LIST_TAG)
  writeUint32(stream, list.members.length)
  flush(stream)
  stream.hash = fnv1aContinueTaggedNumbers(stream.hash, NUMBER_TAG, list.members)
}

function writeValue(stream: BindingStream, value: unknown): void {
  if (value instanceof NumberList) {
    writeNumberList(stream, value)
    return
  }
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
    bound.value = new NumberList(vector.value)
  }
  if (vector.text !== undefined) {
    delete bound.value
  }
  return bound
}

function boundRerankOf(rerank: unknown): unknown {
  if (typeof rerank !== 'object' || rerank === null || Array.isArray(rerank)) return rerank
  const present: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rerank)) {
    if (value !== undefined) present[key] = value
  }
  return present
}

function presentMembersOf(record: object): Record<string, unknown> {
  const present: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) present[key] = value
  }
  return present
}

function boundBm25Of(bm25: BM25Params): unknown {
  const bound = presentMembersOf(bm25)
  const fields = bm25.fields
  if (typeof fields !== 'object' || fields === null) return bound
  const boundFields: Record<string, unknown> = {}
  for (const [name, pair] of Object.entries(fields)) {
    const members = typeof pair === 'object' && pair !== null ? presentMembersOf(pair) : pair
    if (typeof members === 'object' && members !== null && Object.keys(members).length === 0) continue
    boundFields[name] = members
  }
  if (Object.keys(boundFields).length === 0) delete bound.fields
  else bound.fields = boundFields
  return bound
}

const FILTERS_SLOT = 2
const BOUND_SLOT_COUNT = 16

function bindingOf(values: unknown[], clock?: SearchClock): string {
  const stream: BindingStream = { bytes: new Uint8Array(256), length: 0, hash: FNV_OFFSET_BASIS, clock }
  for (const value of values) {
    writeValue(stream, value)
  }
  flush(stream)
  return (stream.hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Computes the cursor binding of a search request: the FNV-1a hash, as eight
 * lowercase hex digits, over the values that decide which documents a page
 * holds. A reader recomputes it and rejects a cursor whose binding differs, so
 * a cursor pages only the request that produced it. The specification's
 * cursor-binding section fixes the value order and the byte encoding.
 */
export function queryBindingOf(params: QueryParams, clock?: SearchClock): string {
  const values: unknown[] = [
    params.term,
    params.fields,
    params.filters,
    params.boost,
    params.minScore,
    params.termMatch,
    params.tolerance,
    params.prefixLength,
    params.prefix,
    params.partialWords,
    params.exact,
    params.pinned,
    params.mode,
    params.hybrid,
    boundVectorOf(params.vector),
    params.scoring ?? 'local',
  ]
  if (params.rerank !== undefined) values.push(boundRerankOf(params.rerank))
  if (params.bm25 !== undefined && bm25SetsValue(params.bm25)) values.push(boundBm25Of(params.bm25))
  return bindingOf(values, clock)
}

export function lazyQueryBinding(params: QueryParams, clock?: SearchClock): CursorBinding {
  let binding: string | undefined
  return () => {
    binding ??= queryBindingOf(params, clock)
    return binding
  }
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
