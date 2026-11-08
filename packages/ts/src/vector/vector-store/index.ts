import {
  createDocIdMap,
  ErrorCodes,
  IN_MEMORY,
  NarsilError,
  STORE_LIVE_COUNT,
  STORE_ORDINAL_LAYOUT_GENERATION,
  STORE_RELEASED_VECTORS_TO_DISK,
  sharedVectorStoreBytes,
  VECTOR_MEMORY_LIMITS,
  writeSequenceOf,
} from '#platform/vector-host'
import type { OrdinalFilter } from '../ordinal-filter'
import type { OsqBits } from '../osq/quantize'
import { docIdsOf, entriesOf, snapshotOf } from './listing'
import { loadColdVector, loadReplacedVector, loadSnapshot } from './load'
import {
  blockFullyCold,
  fileHoldsSameBytes,
  forgetUnreferencedFiles,
  growthBytesFor,
  type OpenStore,
  openHandles,
  partitionFilterOf,
  relayout,
  relocateFiles,
} from './open-store'
import { createOrdinalReads, entryAt } from './ordinal-reads'
import { createRetiredVectorPins, pinnedReads } from './retired-pins'
import {
  appendOrdinal,
  beginWrite,
  endWrite,
  freeAwaitingOrdinals,
  freeable,
  freeRetired,
  NO_PARTITION,
  oldestPinOf,
  readable,
  retireDocument,
  retireInWrite,
  retireOrdinal,
  type StoreState,
  settleReplacement,
  UNKNOWN_PARTITION,
} from './retirement'
import { clearStore } from './store-clear'
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

export function createVectorStore(options?: VectorStoreOptions): VectorStore {
  const codeBits: OsqBits | null = options?.codeBits ?? null
  const blockBytes = Math.min(options?.blockBytes ?? VECTOR_MEMORY_LIMITS.blockBytes, VECTOR_MEMORY_LIMITS.blockBytes)
  const state: StoreState = {
    open: options?.dimension === undefined ? null : openHandles(options.dimension, codeBits, blockBytes),
    docToOrd: createDocIdMap<number>(),
    ordToDoc: [],
    replacedOrdinals: new Set<number>(),
    awaitingFree: new Set<number>(),
    checkpointPins: createRetiredVectorPins(),
    unknownPartitions: 0,
    liveCount: 0,
  }
  const { docToOrd, ordToDoc, replacedOrdinals } = state
  let readBackVector: Float32Array | null = null

  function forgetDocuments(): void {
    docToOrd.clear()
    ordToDoc.length = 0
    replacedOrdinals.clear()
    state.awaitingFree.clear()
    state.checkpointPins.forget()
    state.unknownPartitions = 0
    state.liveCount = 0
  }

  const isReadable = (ordinal: number): boolean => readable(state, ordinal)

  function requireOpen(): OpenStore {
    if (state.open === null) {
      throw new NarsilError(ErrorCodes.VECTOR_DIMENSION_MISMATCH, 'The vector store holds no vector yet')
    }
    return state.open
  }

  function openFor(dimension: number): OpenStore {
    state.open ??= openHandles(dimension, codeBits, blockBytes)
    return state.open
  }

  return {
    ...createOrdinalReads(() => state.open, isReadable),

    get size() {
      return state.liveCount
    },

    get slots() {
      return ordToDoc.length
    },

    get dimension() {
      return state.open === null ? 0 : state.open.handles.dimension
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

    get replacedVectorCount() {
      return replacedOrdinals.size
    },

    insert(docId: string, vector: Float32Array, partitionId?: number, keepsReplacedVector = false): number {
      const store = openFor(vector.length)
      if (vector.length !== store.handles.dimension) {
        throw new NarsilError(
          ErrorCodes.VECTOR_DIMENSION_MISMATCH,
          `Vector dimension mismatch: expected ${store.handles.dimension}, got ${vector.length}`,
          { expected: store.handles.dimension, received: vector.length },
        )
      }
      const previous = docToOrd.get(docId)
      const sequence = beginWrite(state, store)
      const ordinal = appendOrdinal(state, store, docId, vector, sequence, partitionId)
      if (previous !== undefined) retireInWrite(store, previous, sequence)
      endWrite(store, sequence)
      settleReplacement(state, store, previous, keepsReplacedVector)
      return ordinal
    },

    retire(docId: string): void {
      retireDocument(state, docId)
    },

    freeRetiredVectors(): void {
      freeAwaitingOrdinals(state)
    },

    oldestPin(): number {
      return state.open === null ? Number.POSITIVE_INFINITY : oldestPinOf(state.open)
    },

    writeSequence(): number {
      return state.open === null ? 0 : writeSequenceOf(state.open.sequences.header)
    },

    mayFreeOrdinal(ordinal: number, oldestPin: number): boolean {
      return state.open !== null && freeable(state.open, ordinal, oldestPin)
    },

    releaseReplacedVectors(oldestPin?: number): number[] {
      const store = state.open
      const released: number[] = []
      const oldest = oldestPin ?? (store === null ? Number.POSITIVE_INFINITY : oldestPinOf(store))
      for (const ordinal of replacedOrdinals) {
        if (store !== null && !freeable(store, ordinal, oldest)) continue
        released.push(ordinal)
      }
      for (const ordinal of released) {
        replacedOrdinals.delete(ordinal)
        if (store !== null) freeRetired(state, store, ordinal)
      }
      return released
    },

    ...pinnedReads(state.checkpointPins, () => state.open, isReadable),

    insertCold(docId: string, vectorMagnitude: number, location: DiskLocation, partitionId?: number): number {
      return loadColdVector(state, requireOpen(), docId, vectorMagnitude, location, partitionId)
    },

    insertReplaced(docId: string, vector: Float32Array, location?: DiskLocation): number {
      return loadReplacedVector(state, openFor(vector.length), docId, vector, location)
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
      if (state.open === null) return false
      return state.open.view.isCold(ordinal)
    },

    releaseToFile(ordinal: number, location: DiskLocation): boolean {
      const store = requireOpen()
      if (ordToDoc[ordinal] === undefined) return false
      if (store.diskFile[ordinal] === IN_MEMORY) {
        readBackVector ??= new Float32Array(store.handles.dimension)
        if (!fileHoldsSameBytes(store, ordinal, location, readBackVector)) return false
      }
      Atomics.store(store.handles.header, STORE_RELEASED_VECTORS_TO_DISK, 1)
      store.diskOffset[ordinal] = location.offset
      store.diskFile[ordinal] = location.fileIndex
      return true
    },

    releaseColdBlocks(): number {
      const store = requireOpen()
      const held = new Set(replacedOrdinals)
      for (const ordinal of state.awaitingFree) held.add(ordinal)
      const kept = state.checkpointPins.keptWith(held)
      let released = 0
      for (let index = 0; index < store.handles.blocks.length; index++) {
        if (store.handles.blocks[index] === null || !blockFullyCold(store, index, ordToDoc, kept)) continue
        store.handles.blocks[index] = null
        released += 1
      }
      if (released + forgetUnreferencedFiles(store, ordToDoc, kept) > 0) relayout(store)
      return released
    },

    setPartition(docId: string, partitionId: number): void {
      const ordinal = docToOrd.get(docId)
      if (ordinal === undefined || state.open === null || partitionId < 0) return
      if (state.open.partitions[ordinal] === UNKNOWN_PARTITION) state.unknownPartitions -= 1
      state.open.partitions[ordinal] = partitionId
    },

    forgetPartition(docId: string): void {
      const ordinal = docToOrd.get(docId)
      if (ordinal === undefined || state.open === null) return
      if (state.open.partitions[ordinal] === UNKNOWN_PARTITION) state.unknownPartitions -= 1
      state.open.partitions[ordinal] = NO_PARTITION
    },

    partitionOfOrdinal(ordinal: number): number | undefined {
      if (state.open === null || ordinal < 0 || ordinal >= ordToDoc.length) return undefined
      const partitionId = state.open.partitions[ordinal]
      return partitionId < 0 ? undefined : partitionId
    },

    get partitionsKnown(): boolean {
      return state.unknownPartitions === 0
    },

    partitionFilter(partitionIds: ReadonlySet<number>): OrdinalFilter {
      return partitionFilterOf(state.open, ordToDoc, partitionIds)
    },

    remove(docId: string, oldestPin?: number): void {
      const ordinal = docToOrd.get(docId)
      const store = state.open
      if (ordinal === undefined || store === null) return
      const retiredNow = retireDocument(state, docId)
      docToOrd.delete(docId)
      retireOrdinal(state, store, ordinal, retiredNow || oldestPin === undefined ? oldestPinOf(store) : oldestPin)
      state.liveCount--
      Atomics.sub(store.handles.header, STORE_LIVE_COUNT, 1)
    },

    get(docId: string): VectorStoreEntry | undefined {
      const ordinal = docToOrd.get(docId)
      return ordinal === undefined || state.open === null ? undefined : entryAt(state.open, ordinal)
    },

    has(docId: string): boolean {
      return docToOrd.has(docId)
    },

    holdsOrdinal(ordinal: number): boolean {
      return ordinal >= 0 && ordinal < ordToDoc.length && ordToDoc[ordinal] !== undefined
    },

    entries: () => entriesOf(state.open, ordToDoc),

    docIds: () => docIdsOf(state.open, ordToDoc),

    clear(): void {
      const store = state.open
      forgetDocuments()
      if (store !== null) clearStore(store)
    },

    release(): void {
      forgetDocuments()
      if (state.open !== null) Atomics.add(state.open.handles.header, STORE_ORDINAL_LAYOUT_GENERATION, 1)
      state.open?.view.close()
      state.open = null
    },

    closeFiles: () => state.open?.view.close(),

    relocateVectorFiles(rewrite: (path: string) => string): void {
      if (state.open !== null) relocateFiles(state.open, rewrite)
    },

    getOrdinal(docId: string): number | undefined {
      return docToOrd.get(docId)
    },

    docIdForOrdinal(ordinal: number): string | undefined {
      return ordToDoc[ordinal]
    },

    prepareQueryArena(query: Float32Array): ArenaQueryVector | null {
      return state.open === null ? null : state.open.view.prepareQueryArena(query)
    },

    exportSnapshot: () => snapshotOf(state.open, ordToDoc, replacedOrdinals),

    restoreSnapshot(snapshot: VectorStoreSnapshot): void {
      this.clear()
      if (snapshot.dimension === 0 || snapshot.slots === 0) return
      loadSnapshot(state, openFor(snapshot.dimension), snapshot)
    },

    memoryBytes(): number {
      return state.open === null ? 0 : sharedVectorStoreBytes(state.open.handles)
    },

    growthBytesFor(vectors: number): number {
      return state.open === null ? 0 : growthBytesFor(state.open, vectors)
    },
  }
}
