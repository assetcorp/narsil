import type { AppendHandle, DurableDirectory } from '../durability/durable-filesystem'
import {
  LARGEST_REMOVAL_BUCKET_COUNT,
  REMOVAL_BUCKET_TARGET_BYTES,
  REMOVAL_BUCKET_WRITE_BUFFER_BYTES,
} from './constants'
import { loadFailed } from './format'

const TRIPLE_VALUES = 3
const VALUE_BYTES = 4
const TRIPLE_BYTES = TRIPLE_VALUES * VALUE_BYTES

interface RemovalBucket {
  key: string
  handle: AppendHandle
  held: Uint32Array
  heldValues: number
  triples: number
}

export interface RemovalWriter {
  add(ordinal: number, token: number, occurrences: number): Promise<void>
  drain(emit: (offsets: Uint32Array, values: Uint32Array) => Promise<void>): Promise<void>
  abandon(): Promise<void>
}

function bucketCountFor(upperBoundTriples: number): number {
  const wanted = Math.ceil((upperBoundTriples * TRIPLE_BYTES) / REMOVAL_BUCKET_TARGET_BYTES)
  return Math.max(1, Math.min(LARGEST_REMOVAL_BUCKET_COUNT, wanted))
}

export async function openRemovalWriter(
  directory: DurableDirectory,
  keyPrefix: string,
  documentCount: number,
  upperBoundTriples: number,
): Promise<RemovalWriter> {
  const bucketCount = bucketCountFor(upperBoundTriples)
  const ordinalsPerBucket = Math.max(1, Math.ceil(documentCount / bucketCount))
  const heldValues = Math.floor(REMOVAL_BUCKET_WRITE_BUFFER_BYTES / TRIPLE_BYTES) * TRIPLE_VALUES
  const buckets: RemovalBucket[] = []
  for (let at = 0; at < bucketCount; at++) {
    const key = `${keyPrefix}.part-removals-${at}`
    await directory.remove(key)
    buckets.push({
      key,
      handle: await directory.appendHandle(key),
      held: new Uint32Array(heldValues),
      heldValues: 0,
      triples: 0,
    })
  }

  async function flush(bucket: RemovalBucket): Promise<void> {
    if (bucket.heldValues === 0) return
    await bucket.handle.append(new Uint8Array(bucket.held.buffer, 0, bucket.heldValues * VALUE_BYTES))
    bucket.heldValues = 0
  }

  async function drainBucket(
    bucket: RemovalBucket,
    firstOrdinal: number,
    endOrdinal: number,
    firstValue: number,
    emit: (offsets: Uint32Array, values: Uint32Array) => Promise<void>,
  ): Promise<number> {
    await flush(bucket)
    await bucket.handle.close()
    const stored = await directory.read(bucket.key)
    if (stored === null || stored.byteLength !== bucket.triples * TRIPLE_BYTES) {
      loadFailed(`The removal bucket "${bucket.key}" holds the wrong number of bytes`, { key: bucket.key })
    }
    const triples = new Uint32Array(bucket.triples * TRIPLE_VALUES)
    new Uint8Array(triples.buffer).set(stored)
    const span = endOrdinal - firstOrdinal
    const counts = new Uint32Array(span + 1)
    for (let at = 0; at < triples.length; at += TRIPLE_VALUES) counts[triples[at] - firstOrdinal + 1] += 2
    for (let at = 0; at < span; at++) counts[at + 1] += counts[at]
    const values = new Uint32Array(bucket.triples * 2)
    const cursors = counts.slice(0, span)
    for (let at = 0; at < triples.length; at += TRIPLE_VALUES) {
      const row = triples[at] - firstOrdinal
      values[cursors[row]] = triples[at + 1]
      values[cursors[row] + 1] = triples[at + 2]
      cursors[row] += 2
    }
    const offsets = new Uint32Array(span)
    for (let at = 0; at < span; at++) offsets[at] = firstValue + counts[at]
    await emit(offsets, values)
    await directory.remove(bucket.key)
    return firstValue + values.length
  }

  return {
    async add(ordinal: number, token: number, occurrences: number): Promise<void> {
      const bucket = buckets[Math.floor(ordinal / ordinalsPerBucket)]
      bucket.held[bucket.heldValues] = ordinal
      bucket.held[bucket.heldValues + 1] = token
      bucket.held[bucket.heldValues + 2] = occurrences
      bucket.heldValues += TRIPLE_VALUES
      bucket.triples += 1
      if (bucket.heldValues === bucket.held.length) await flush(bucket)
    },

    async drain(emit: (offsets: Uint32Array, values: Uint32Array) => Promise<void>): Promise<void> {
      let nextValue = 0
      for (let at = 0; at < buckets.length; at++) {
        const first = at * ordinalsPerBucket
        const end = Math.min(documentCount, first + ordinalsPerBucket)
        nextValue = await drainBucket(buckets[at], first, Math.max(first, end), nextValue, emit)
      }
      await emit(Uint32Array.of(nextValue), new Uint32Array(0))
    },

    async abandon(): Promise<void> {
      for (const bucket of buckets) {
        await bucket.handle.close().catch(() => undefined)
        await directory.remove(bucket.key).catch(() => undefined)
      }
    },
  }
}
