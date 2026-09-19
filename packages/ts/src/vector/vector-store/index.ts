import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import type { OrdinalFilter } from '../ordinal-filter'
import type { OsqBits } from '../osq/quantize'
import { BLOCK_MAX_BYTES } from './blocks'
import { appendDocId, resetDocIds } from './doc-ids'
import {
  IN_MEMORY,
  STORE_CALIBRATED,
  STORE_CALIBRATION_GENERATION,
  STORE_CODE_COUNT,
  STORE_HOLDS_VECTORS_ON_DISK,
  STORE_LIVE_COUNT,
  STORE_SLOTS,
  sharedVectorStoreBytes,
} from './handles'
import {
  blockFullyCold,
  ensureOrdinal,
  fileHoldsSameBytes,
  forgetUnreferencedFiles,
  type OpenStore,
  openHandles,
  partitionFilterOf,
  relayout,
  writeVector,
} from './open-store'
import type {
  ArenaQueryVector,
  DiskLocation,
  VectorStore,
  VectorStoreEntry,
  VectorStoreOptions,
  VectorStoreSnapshot,
} from './types'

export type {
  ArenaQueryVector,
  DiskLocation,
  VectorBuildReader,
  VectorSearchReader,
  VectorStore,
  VectorStoreEntry,
  VectorStoreOptions,
  VectorStoreSnapshot,
} from './types'

const UNKNOWN_PARTITION = -1
const NO_PARTITION = -2

export function createVectorStore(options?: VectorStoreOptions): VectorStore {
  const codeBits: OsqBits | null = options?.codeBits ?? null
  const blockBytes = options?.blockBytes ?? BLOCK_MAX_BYTES
  const docToOrd = new Map<string, number>()
  const ordToDoc: Array<string | undefined> = []
  let unknownPartitions = 0
  let liveCount = 0
  let open: OpenStore | null =
    options?.dimension === undefined ? null : openHandles(options.dimension, codeBits, blockBytes)

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

  function claimOrdinal(store: OpenStore, docId: string, cold: boolean, partitionId?: number): number {
    const ordinal = Atomics.load(store.handles.header, STORE_SLOTS)
    ensureOrdinal(store, ordinal, cold)
    store.diskFile[ordinal] = IN_MEMORY
    appendDocId(store.handles, ordinal, docId)
    recordPartition(store, ordinal, partitionId)
    ordToDoc[ordinal] = docId
    docToOrd.set(docId, ordinal)
    return ordinal
  }

  function publishOrdinal(store: OpenStore, ordinal: number): void {
    Atomics.store(store.handles.header, STORE_SLOTS, ordinal + 1)
    Atomics.store(store.present, ordinal, 1)
  }

  function appendOrdinal(store: OpenStore, docId: string, vector: Float32Array, partitionId?: number): number {
    const ordinal = claimOrdinal(store, docId, false, partitionId)
    writeVector(store, ordinal, vector)
    publishOrdinal(store, ordinal)
    return ordinal
  }

  function settleReplacement(store: OpenStore, ordinal: number, previous: number | undefined): number {
    if (previous !== undefined) {
      retireOrdinal(store, previous)
      return ordinal
    }
    liveCount++
    Atomics.add(store.handles.header, STORE_LIVE_COUNT, 1)
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

    get codeBits() {
      return codeBits
    },

    get handles() {
      return requireOpen().handles
    },

    get view() {
      return requireOpen().view
    },

    insert(docId: string, vector: Float32Array, partitionId?: number): number {
      if (open === null) open = openHandles(vector.length, codeBits, blockBytes)
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
      return settleReplacement(store, ordinal, previous)
    },

    insertCold(docId: string, vectorMagnitude: number, location: DiskLocation, partitionId?: number): number {
      const store = requireOpen()
      const previous = docToOrd.get(docId)
      Atomics.store(store.handles.header, STORE_HOLDS_VECTORS_ON_DISK, 1)
      const ordinal = claimOrdinal(store, docId, true, partitionId)
      store.magnitudes[ordinal] = vectorMagnitude
      store.diskOffset[ordinal] = location.offset
      store.diskFile[ordinal] = location.fileIndex
      publishOrdinal(store, ordinal)
      return settleReplacement(store, ordinal, previous)
    },

    addVectorFile(path: string): number {
      const store = requireOpen()
      const existing = store.handles.vectorFiles.indexOf(path)
      if (existing !== -1) return existing
      store.handles.vectorFiles.push(path)
      relayout(store)
      return store.handles.vectorFiles.length - 1
    },

    isCold(ordinal: number): boolean {
      if (open === null) return false
      return open.view.isCold(ordinal)
    },

    releaseToFile(ordinal: number, location: DiskLocation): boolean {
      const store = requireOpen()
      if (ordToDoc[ordinal] === undefined) return false
      if (store.diskFile[ordinal] === IN_MEMORY && !fileHoldsSameBytes(store, ordinal, location)) return false
      Atomics.store(store.handles.header, STORE_HOLDS_VECTORS_ON_DISK, 1)
      store.diskOffset[ordinal] = location.offset
      store.diskFile[ordinal] = location.fileIndex
      return true
    },

    releaseColdBlocks(): number {
      const store = requireOpen()
      let released = 0
      for (let index = 0; index < store.handles.blocks.length; index++) {
        if (store.handles.blocks[index] === null || !blockFullyCold(store, index, ordToDoc)) continue
        store.handles.blocks[index] = null
        released += 1
      }
      if (released > 0) {
        forgetUnreferencedFiles(store, ordToDoc)
        relayout(store)
      }
      return released
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
      return partitionFilterOf(open, ordToDoc, partitionIds)
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
      new Int32Array(open.handles.diskFile).fill(IN_MEMORY)
      open.handles.centroid.fill(0)
      if (open.handles.vectorFiles.length > 0) {
        open.handles.vectorFiles.length = 0
        relayout(open)
      }
      resetDocIds(open.handles)
      Atomics.store(open.handles.header, STORE_SLOTS, 0)
      Atomics.store(open.handles.header, STORE_HOLDS_VECTORS_ON_DISK, 0)
      Atomics.store(open.handles.header, STORE_LIVE_COUNT, 0)
      Atomics.store(open.handles.header, STORE_CODE_COUNT, 0)
      Atomics.store(open.handles.header, STORE_CALIBRATED, 0)
      Atomics.add(open.handles.header, STORE_CALIBRATION_GENERATION, 1)
    },

    release(): void {
      forgetDocuments()
      open?.view.close()
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

    queryDistance(prepared: ArenaQueryVector, metric: VectorMetric): (ordinal: number) => number {
      if (open === null) return () => Number.POSITIVE_INFINITY
      const inner = open.view.queryDistance(prepared, metric)
      return ordinal => (ordToDoc[ordinal] === undefined ? Number.POSITIVE_INFINITY : inner(ordinal))
    },

    ordinalDistance(from: number, metric: VectorMetric): (ordinal: number) => number {
      const pair = this.pairDistance(metric)
      return ordinal => pair(from, ordinal)
    },

    pairDistance(metric: VectorMetric): (ordA: number, ordB: number) => number {
      if (open === null) return () => Number.POSITIVE_INFINITY
      const inner = open.view.pairDistance(metric)
      return (ordA, ordB) =>
        ordToDoc[ordA] === undefined || ordToDoc[ordB] === undefined ? Number.POSITIVE_INFINITY : inner(ordA, ordB)
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
      if (open === null) open = openHandles(snapshot.dimension, codeBits, blockBytes)
      const store = open
      for (let ordinal = 0; ordinal < snapshot.slots; ordinal++) {
        const docId = snapshot.docIds[ordinal]
        const vector = snapshot.vectors.subarray(ordinal * snapshot.dimension, (ordinal + 1) * snapshot.dimension)
        if (docId === null || docId === undefined) {
          ensureOrdinal(store, ordinal, false)
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
