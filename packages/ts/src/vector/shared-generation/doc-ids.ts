import type { VectorStore } from '../vector-store'

const ABSENT_PARTITION = -1

/**
 * The document id and partition at each ordinal of a frozen copy, held in
 * shared memory so that every request thread reads one table.
 *
 * A thread decodes an id only for the ordinals a search returns, so each hit
 * costs one small decode, and a thread builds a reverse table of its own only
 * once a query filters by document id.
 *
 * @internal
 */
export interface SharedDocIdTable {
  /** Every document id, UTF-8 encoded end to end in ordinal order. */
  bytes: Uint8Array
  /** Where each ordinal's id starts inside `bytes`, with one closing offset. */
  offsets: Uint32Array
  /** Each ordinal's partition, or -1 where the ordinal holds no document or no partition is known. */
  partitions: Int32Array
}

/**
 * Builds the shared id table for every ordinal of a store.
 *
 * @param store The store to read ids and partitions from.
 * @param slots The number of ordinals the table spans.
 * @returns The table, backed by shared buffers.
 *
 * @internal
 */
export function buildSharedDocIdTable(store: VectorStore, slots: number): SharedDocIdTable {
  const encoder = new TextEncoder()
  const encoded: Array<Uint8Array | null> = new Array(slots)
  let totalBytes = 0
  for (let ordinal = 0; ordinal < slots; ordinal++) {
    const docId = store.docIdForOrdinal(ordinal)
    if (docId === undefined) {
      encoded[ordinal] = null
      continue
    }
    const bytes = encoder.encode(docId)
    encoded[ordinal] = bytes
    totalBytes += bytes.length
  }

  const table: SharedDocIdTable = {
    bytes: new Uint8Array(new SharedArrayBuffer(totalBytes)),
    offsets: new Uint32Array(new SharedArrayBuffer((slots + 1) * 4)),
    partitions: new Int32Array(new SharedArrayBuffer(slots * 4)),
  }
  let cursor = 0
  for (let ordinal = 0; ordinal < slots; ordinal++) {
    table.offsets[ordinal] = cursor
    const bytes = encoded[ordinal]
    if (bytes === null) {
      table.partitions[ordinal] = ABSENT_PARTITION
      continue
    }
    table.bytes.set(bytes, cursor)
    cursor += bytes.length
    table.partitions[ordinal] = store.partitionOfOrdinal(ordinal) ?? ABSENT_PARTITION
  }
  table.offsets[slots] = cursor
  return table
}

const decoder = new TextDecoder()

/**
 * Reads the document id at an ordinal.
 *
 * @param table The shared table to read.
 * @param ordinal The ordinal to look up.
 * @returns The id, or undefined where the ordinal holds no document.
 *
 * @internal
 */
export function docIdAt(table: SharedDocIdTable, ordinal: number): string | undefined {
  if (ordinal < 0 || ordinal >= table.partitions.length) return undefined
  const start = table.offsets[ordinal]
  const end = table.offsets[ordinal + 1]
  if (start === end) return undefined
  return decoder.decode(table.bytes.subarray(start, end))
}

/**
 * Reads the partition at an ordinal.
 *
 * @param table The shared table to read.
 * @param ordinal The ordinal to look up.
 * @returns The partition, or undefined where none is recorded.
 *
 * @internal
 */
export function partitionAt(table: SharedDocIdTable, ordinal: number): number | undefined {
  if (ordinal < 0 || ordinal >= table.partitions.length) return undefined
  const partition = table.partitions[ordinal]
  return partition === ABSENT_PARTITION ? undefined : partition
}
