import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import { MAX_VECTOR_ORDINALS } from '../constants'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter } from '../ordinal-filter'
import { growBufferTo } from '../shared-buffers/growable'
import { magnitude } from '../similarity'
import { createVectorBlock, ensureBlockSlots, slotByteOffset } from './blocks'
import { appendDocId, resetDocIds } from './doc-ids'
import {
  createSharedVectorStoreHandles,
  type SharedVectorStoreHandles,
  STORE_BLOCK_COUNT,
  STORE_CALIBRATED,
  STORE_CODE_COUNT,
  STORE_LIVE_COUNT,
  STORE_SLOTS,
  sharedVectorStoreBytes,
} from './handles'
import type { ArenaQueryVector, VectorStore, VectorStoreEntry, VectorStoreOptions, VectorStoreSnapshot } from './types'
import { openSharedVectorStore, type SharedVectorStoreView } from './view'

export type {
  ArenaQueryVector,
  VectorBuildReader,
  VectorSearchReader,
  VectorStore,
  VectorStoreEntry,
  VectorStoreOptions,
  VectorStoreSnapshot,
} from './types'

const UNKNOWN_PARTITION = -1
const NO_PARTITION = -2

interface OpenStore {
  handles: SharedVectorStoreHandles
  view: SharedVectorStoreView
  magnitudes: Float64Array
  present: Uint8Array
  partitions: Int32Array
}

/**
 * Builds the store of one vector field, which appends every vector at a fresh
 * ordinal in shared blocks that every thread reads in place.
 *
 * @param options The dimension and whether each slot keeps byte codes beside
 * the vector, both of which the first inserted vector settles where the
 * caller gives neither.
 * @returns The store.
 *
 * @internal
 */
export function createVectorStore(options?: VectorStoreOptions): VectorStore {
  const quantized = options?.quantized ?? true
  const docToOrd = new Map<string, number>()
  const ordToDoc: Array<string | undefined> = []
  let unknownPartitions = 0
  let liveCount = 0
  let open: OpenStore | null = options?.dimension === undefined ? null : openHandles(options.dimension)

  function openHandles(dimension: number): OpenStore {
    const handles = createSharedVectorStoreHandles(dimension, quantized)
    return {
      handles,
      view: openSharedVectorStore(handles, 0),
      magnitudes: new Float64Array(handles.magnitudes),
      present: new Uint8Array(handles.present),
      partitions: new Int32Array(handles.partitions),
    }
  }

  function forgetDocuments(): void {
    docToOrd.clear()
    ordToDoc.length = 0
    unknownPartitions = 0
    liveCount = 0
  }

  function requireOpen(): OpenStore {
    if (open === null) {
      throw new NarsilError(ErrorCodes.VECTOR_DIMENSION_MISMATCH, 'The vector store holds no vector yet')
    }
    return open
  }

  function ensureOrdinal(store: OpenStore, ordinal: number): void {
    if (ordinal >= MAX_VECTOR_ORDINALS) {
      throw new NarsilError(
        ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
        `A vector field holds at most ${MAX_VECTOR_ORDINALS} vectors, deleted ones included, until it is rebuilt`,
        { ordinal, maxOrdinals: MAX_VECTOR_ORDINALS },
      )
    }
    const { handles } = store
    growBufferTo(handles.magnitudes, (ordinal + 1) * 8)
    growBufferTo(handles.present, ordinal + 1)
    growBufferTo(handles.partitions, (ordinal + 1) * 4)
    growBufferTo(handles.codeSums, (ordinal + 1) * 8)
    growBufferTo(handles.codeSumSqs, (ordinal + 1) * 8)
    growBufferTo(handles.codeMagnitudes, (ordinal + 1) * 8)
    growBufferTo(handles.codePresent, ordinal + 1)
    const blockIndex = Math.floor(ordinal / handles.layout.capacity)
    while (handles.blocks.length <= blockIndex) {
      handles.blocks.push(createVectorBlock(handles.layout))
      Atomics.store(handles.header, STORE_BLOCK_COUNT, handles.blocks.length)
      store.view.adoptHandles(handles)
    }
    ensureBlockSlots(handles.blocks[blockIndex], (ordinal % handles.layout.capacity) + 1)
  }

  function writeVector(store: OpenStore, ordinal: number, vector: Float32Array): void {
    const block = store.view.blockOf(ordinal)
    const base = slotByteOffset(store.handles.layout, store.view.localOrdinal(ordinal)) / 4
    block.float32(base + vector.length).set(vector, base)
    store.magnitudes[ordinal] = magnitude(vector)
  }

  function recordPartition(store: OpenStore, ordinal: number, partitionId: number | undefined): void {
    const given = partitionId !== undefined && partitionId >= 0 ? partitionId : UNKNOWN_PARTITION
    store.partitions[ordinal] = given
    if (given === UNKNOWN_PARTITION) unknownPartitions += 1
  }

  function retireOrdinal(store: OpenStore, ordinal: number): void {
    ordToDoc[ordinal] = undefined
    Atomics.store(store.present, ordinal, 0)
    if (store.partitions[ordinal] === UNKNOWN_PARTITION) unknownPartitions -= 1
  }

  function appendOrdinal(store: OpenStore, docId: string, vector: Float32Array, partitionId?: number): number {
    const ordinal = Atomics.load(store.handles.header, STORE_SLOTS)
    ensureOrdinal(store, ordinal)
    writeVector(store, ordinal, vector)
    appendDocId(store.handles, ordinal, docId)
    recordPartition(store, ordinal, partitionId)
    ordToDoc[ordinal] = docId
    docToOrd.set(docId, ordinal)
    Atomics.store(store.handles.header, STORE_SLOTS, ordinal + 1)
    Atomics.store(store.present, ordinal, 1)
    return ordinal
  }

  function entryAt(store: OpenStore, ordinal: number): VectorStoreEntry {
    return { vector: store.view.vectorAt(ordinal), magnitude: store.magnitudes[ordinal] }
  }

  return {
    get size() {
      return liveCount
    },

    get slots() {
      return ordToDoc.length
    },

    get dimension() {
      return open === null ? 0 : open.handles.dimension
    },

    get quantized() {
      return quantized
    },

    get handles() {
      return requireOpen().handles
    },

    get view() {
      return requireOpen().view
    },

    insert(docId: string, vector: Float32Array, partitionId?: number): number {
      if (open === null) open = openHandles(vector.length)
      const store = open
      if (vector.length !== store.handles.dimension) {
        throw new NarsilError(
          ErrorCodes.VECTOR_DIMENSION_MISMATCH,
          `Vector dimension mismatch: expected ${store.handles.dimension}, got ${vector.length}`,
          { expected: store.handles.dimension, received: vector.length },
        )
      }
      const previous = docToOrd.get(docId)
      const ordinal = appendOrdinal(store, docId, vector, partitionId)
      if (previous !== undefined) {
        retireOrdinal(store, previous)
        return ordinal
      }
      liveCount++
      Atomics.add(store.handles.header, STORE_LIVE_COUNT, 1)
      return ordinal
    },

    setPartition(docId: string, partitionId: number): void {
      const ordinal = docToOrd.get(docId)
      if (ordinal === undefined || open === null || partitionId < 0) return
      if (open.partitions[ordinal] === UNKNOWN_PARTITION) unknownPartitions -= 1
      open.partitions[ordinal] = partitionId
    },

    forgetPartition(docId: string): void {
      const ordinal = docToOrd.get(docId)
      if (ordinal === undefined || open === null) return
      if (open.partitions[ordinal] === UNKNOWN_PARTITION) unknownPartitions -= 1
      open.partitions[ordinal] = NO_PARTITION
    },

    partitionOfOrdinal(ordinal: number): number | undefined {
      if (open === null || ordinal < 0 || ordinal >= ordToDoc.length) return undefined
      const partitionId = open.partitions[ordinal]
      return partitionId < 0 ? undefined : partitionId
    },

    get partitionsKnown(): boolean {
      return unknownPartitions === 0
    },

    partitionFilter(partitionIds: ReadonlySet<number>): OrdinalFilter {
      const filter = createOrdinalFilter(ordToDoc.length)
      if (open === null) return filter
      let highest = -1
      for (const partitionId of partitionIds) {
        if (partitionId > highest) highest = partitionId
      }
      if (highest < 0) return filter
      const wanted = new Uint8Array(highest + 1)
      for (const partitionId of partitionIds) {
        if (partitionId >= 0) wanted[partitionId] = 1
      }
      for (let ordinal = 0; ordinal < ordToDoc.length; ordinal++) {
        if (ordToDoc[ordinal] === undefined) continue
        const partitionId = open.partitions[ordinal]
        if (partitionId < 0 || partitionId > highest || wanted[partitionId] === 0) continue
        addToOrdinalFilter(filter, ordinal)
      }
      return filter
    },

    remove(docId: string): void {
      const ordinal = docToOrd.get(docId)
      if (ordinal === undefined || open === null) return
      docToOrd.delete(docId)
      retireOrdinal(open, ordinal)
      liveCount--
      Atomics.sub(open.handles.header, STORE_LIVE_COUNT, 1)
    },

    get(docId: string): VectorStoreEntry | undefined {
      const ordinal = docToOrd.get(docId)
      return ordinal === undefined || open === null ? undefined : entryAt(open, ordinal)
    },

    has(docId: string): boolean {
      return docToOrd.has(docId)
    },

    holdsOrdinal(ordinal: number): boolean {
      return ordinal >= 0 && ordinal < ordToDoc.length && ordToDoc[ordinal] !== undefined
    },

    *entries(): IterableIterator<[string, VectorStoreEntry]> {
      if (open === null) return
      for (let ordinal = 0; ordinal < ordToDoc.length; ordinal++) {
        const docId = ordToDoc[ordinal]
        if (docId === undefined) continue
        yield [docId, entryAt(open, ordinal)]
      }
    },

    clear(): void {
      forgetDocuments()
      if (open === null) return
      open.present.fill(0)
      new Uint8Array(open.handles.codePresent).fill(0)
      resetDocIds(open.handles)
      Atomics.store(open.handles.header, STORE_SLOTS, 0)
      Atomics.store(open.handles.header, STORE_LIVE_COUNT, 0)
      Atomics.store(open.handles.header, STORE_CODE_COUNT, 0)
      Atomics.store(open.handles.header, STORE_CALIBRATED, 0)
    },

    release(): void {
      forgetDocuments()
      open = null
    },

    getOrdinal(docId: string): number | undefined {
      return docToOrd.get(docId)
    },

    docIdForOrdinal(ordinal: number): string | undefined {
      return ordToDoc[ordinal]
    },

    entryForOrdinal(ordinal: number): VectorStoreEntry | undefined {
      if (open === null || ordinal < 0 || ordinal >= ordToDoc.length || ordToDoc[ordinal] === undefined) {
        return undefined
      }
      return entryAt(open, ordinal)
    },

    distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number {
      if (open === null || ordToDoc[ordA] === undefined || ordToDoc[ordB] === undefined) {
        return Number.POSITIVE_INFINITY
      }
      return open.view.distanceByOrdinal(ordA, ordB, metric)
    },

    prepareQueryArena(query: Float32Array): ArenaQueryVector | null {
      return open === null ? null : open.view.prepareQueryArena(query)
    },

    distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number {
      if (open === null || ordToDoc[ordinal] === undefined) return Number.POSITIVE_INFINITY
      return open.view.distanceFromArena(prepared, ordinal, metric)
    },

    exportSnapshot(): VectorStoreSnapshot {
      const slots = ordToDoc.length
      const dimension = open === null ? 0 : open.handles.dimension
      const vectors = new Float32Array(slots * dimension)
      const magnitudes = new Float64Array(slots)
      const docIds: Array<string | null> = new Array(slots)
      for (let ordinal = 0; ordinal < slots; ordinal++) {
        const docId = ordToDoc[ordinal]
        docIds[ordinal] = docId ?? null
        if (docId === undefined || open === null) continue
        vectors.set(open.view.vectorAt(ordinal), ordinal * dimension)
        magnitudes[ordinal] = open.magnitudes[ordinal]
      }
      return { dimension, slots, vectors, magnitudes, docIds }
    },

    restoreSnapshot(snapshot: VectorStoreSnapshot): void {
      this.clear()
      if (snapshot.dimension === 0 || snapshot.slots === 0) return
      if (open === null) open = openHandles(snapshot.dimension)
      const store = open
      for (let ordinal = 0; ordinal < snapshot.slots; ordinal++) {
        const docId = snapshot.docIds[ordinal]
        const vector = snapshot.vectors.subarray(ordinal * snapshot.dimension, (ordinal + 1) * snapshot.dimension)
        if (docId === null || docId === undefined) {
          ensureOrdinal(store, ordinal)
          ordToDoc[ordinal] = undefined
          store.partitions[ordinal] = NO_PARTITION
          Atomics.store(store.handles.header, STORE_SLOTS, ordinal + 1)
          continue
        }
        appendOrdinal(store, docId, vector)
        liveCount++
      }
      Atomics.store(store.handles.header, STORE_LIVE_COUNT, liveCount)
    },

    memoryBytes(): number {
      return open === null ? 0 : sharedVectorStoreBytes(open.handles)
    },
  }
}
