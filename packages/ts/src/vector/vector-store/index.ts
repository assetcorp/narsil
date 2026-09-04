import type { VectorMetric } from '../brute-force'
import { VECTOR_STORE_INITIAL_CAPACITY, WASM_PAGE_BYTES } from '../constants'
import { addToOrdinalFilter, createOrdinalFilter, type OrdinalFilter } from '../ordinal-filter'
import { type ArenaSimd, arenaFloat32Distance, createArenaSimd } from '../simd'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../similarity'
import type { ArenaQueryVector, VectorStore, VectorStoreEntry, VectorStoreSnapshot } from './types'

export type {
  ArenaQueryVector,
  VectorSearchReader,
  VectorStore,
  VectorStoreEntry,
  VectorStoreSnapshot,
} from './types'

const UNKNOWN_PARTITION = -1
const NO_PARTITION = -2

export function createVectorStore(): VectorStore {
  const docToOrd = new Map<string, number>()
  const recycledOrds = new Map<string, number>()
  const ordToDoc: Array<string | undefined> = []
  let partitionOf = new Int32Array(0)
  let unknownPartitions = 0
  let simd: ArenaSimd | null = createArenaSimd()

  let dimension = 0
  let capacity = 0
  let arena = new Float32Array(0)
  let mags = new Float64Array(0)
  let liveCount = 0
  let scratchByteLength = 0
  let scratchFloatLength = 0

  function initStorage(dim: number): void {
    dimension = dim
    if (simd) {
      scratchByteLength = Math.max(16, Math.ceil((dim * 4) / 16) * 16)
      scratchFloatLength = scratchByteLength / 4
      arena = new Float32Array(simd.memory.buffer)
    }
  }

  function ensureCapacity(needed: number): void {
    if (needed <= capacity) return
    let newCap = capacity === 0 ? VECTOR_STORE_INITIAL_CAPACITY : capacity
    while (newCap < needed) newCap *= 2

    const nextMags = new Float64Array(newCap)
    nextMags.set(mags)
    mags = nextMags

    if (simd) {
      const requiredBytes = scratchByteLength + newCap * dimension * 4
      const have = simd.memory.buffer.byteLength
      if (requiredBytes > have) {
        try {
          simd.memory.grow(Math.ceil((requiredBytes - have) / WASM_PAGE_BYTES))
        } catch {
          const migrated = new Float32Array(newCap * dimension)
          migrated.set(arena.subarray(scratchFloatLength, scratchFloatLength + capacity * dimension))
          arena = migrated
          simd = null
          scratchByteLength = 0
          scratchFloatLength = 0
          capacity = newCap
          return
        }
      }
      arena = new Float32Array(simd.memory.buffer)
    } else {
      const nextArena = new Float32Array(newCap * dimension)
      nextArena.set(arena.subarray(0, capacity * dimension))
      arena = nextArena
    }

    capacity = newCap
  }

  function writeVector(ord: number, vector: Float32Array): void {
    arena.set(vector, scratchFloatLength + ord * dimension)
    mags[ord] = magnitude(vector)
  }

  function entryAt(ord: number): VectorStoreEntry {
    const base = scratchFloatLength + ord * dimension
    return { vector: arena.subarray(base, base + dimension), magnitude: mags[ord] }
  }

  function ensurePartitionSlots(ord: number): void {
    if (ord < partitionOf.length) return
    let length = partitionOf.length === 0 ? VECTOR_STORE_INITIAL_CAPACITY : partitionOf.length
    while (length <= ord) length *= 2
    const grown = new Int32Array(length).fill(UNKNOWN_PARTITION)
    grown.set(partitionOf)
    partitionOf = grown
  }

  function recordPartition(ord: number, partitionId: number | undefined, wasLive: boolean): void {
    ensurePartitionSlots(ord)
    const previous = partitionOf[ord]
    const given = partitionId !== undefined && partitionId >= 0 ? partitionId : undefined
    const next = given ?? (wasLive ? previous : UNKNOWN_PARTITION)
    partitionOf[ord] = next
    if (!wasLive && next === UNKNOWN_PARTITION) {
      unknownPartitions += 1
      return
    }
    if (wasLive && previous === UNKNOWN_PARTITION && next !== UNKNOWN_PARTITION) {
      unknownPartitions -= 1
    }
  }

  return {
    get size() {
      return liveCount
    },

    get slots() {
      return ordToDoc.length
    },

    insert(docId: string, vector: Float32Array, partitionId?: number): void {
      if (dimension === 0) initStorage(vector.length)

      const existing = docToOrd.get(docId)
      if (existing !== undefined) {
        writeVector(existing, vector)
        recordPartition(existing, partitionId, true)
        return
      }
      const recycled = recycledOrds.get(docId)
      if (recycled !== undefined) {
        recycledOrds.delete(docId)
        docToOrd.set(docId, recycled)
        ordToDoc[recycled] = docId
        ensureCapacity(recycled + 1)
        writeVector(recycled, vector)
        recordPartition(recycled, partitionId, false)
        liveCount++
        return
      }
      const ord = ordToDoc.length
      docToOrd.set(docId, ord)
      ordToDoc.push(docId)
      ensureCapacity(ord + 1)
      writeVector(ord, vector)
      recordPartition(ord, partitionId, false)
      liveCount++
    },

    setPartition(docId: string, partitionId: number): void {
      const ord = docToOrd.get(docId)
      if (ord === undefined) return
      recordPartition(ord, partitionId, true)
    },

    forgetPartition(docId: string): void {
      const ord = docToOrd.get(docId)
      if (ord === undefined || ord >= partitionOf.length) return
      if (partitionOf[ord] === UNKNOWN_PARTITION) {
        unknownPartitions -= 1
      }
      partitionOf[ord] = NO_PARTITION
    },

    partitionOfOrdinal(ordinal: number): number | undefined {
      if (ordinal < 0 || ordinal >= partitionOf.length) return undefined
      const partitionId = partitionOf[ordinal]
      return partitionId < 0 ? undefined : partitionId
    },

    get partitionsKnown(): boolean {
      return unknownPartitions === 0
    },

    partitionFilter(partitionIds: ReadonlySet<number>): OrdinalFilter {
      const filter = createOrdinalFilter(ordToDoc.length)
      let highest = -1
      for (const partitionId of partitionIds) {
        if (partitionId > highest) highest = partitionId
      }
      if (highest < 0) return filter
      const wanted = new Uint8Array(highest + 1)
      for (const partitionId of partitionIds) {
        if (partitionId >= 0) wanted[partitionId] = 1
      }
      const upperBound = Math.min(ordToDoc.length, partitionOf.length)
      for (let ord = 0; ord < upperBound; ord++) {
        if (ordToDoc[ord] === undefined) continue
        const partitionId = partitionOf[ord]
        if (partitionId < 0 || partitionId > highest || wanted[partitionId] === 0) continue
        addToOrdinalFilter(filter, ord)
      }
      return filter
    },

    remove(docId: string): void {
      const ord = docToOrd.get(docId)
      if (ord === undefined) return
      docToOrd.delete(docId)
      ordToDoc[ord] = undefined
      recycledOrds.set(docId, ord)
      if (ord < partitionOf.length && partitionOf[ord] === UNKNOWN_PARTITION) {
        unknownPartitions -= 1
      }
      liveCount--
    },

    get(docId: string): VectorStoreEntry | undefined {
      const ord = docToOrd.get(docId)
      return ord === undefined ? undefined : entryAt(ord)
    },

    has(docId: string): boolean {
      return docToOrd.has(docId)
    },

    *entries(): IterableIterator<[string, VectorStoreEntry]> {
      for (let ord = 0; ord < ordToDoc.length; ord++) {
        const docId = ordToDoc[ord]
        if (docId === undefined) continue
        yield [docId, entryAt(ord)]
      }
    },

    clear(): void {
      docToOrd.clear()
      recycledOrds.clear()
      ordToDoc.length = 0
      partitionOf = new Int32Array(0)
      unknownPartitions = 0
      mags = new Float64Array(0)
      if (!simd) {
        arena = new Float32Array(0)
      }
      dimension = 0
      capacity = 0
      liveCount = 0
      scratchByteLength = 0
      scratchFloatLength = 0
    },

    getOrdinal(docId: string): number | undefined {
      return docToOrd.get(docId)
    },

    docIdForOrdinal(ordinal: number): string | undefined {
      return ordToDoc[ordinal]
    },

    entryForOrdinal(ordinal: number): VectorStoreEntry | undefined {
      if (ordinal < 0 || ordinal >= ordToDoc.length || ordToDoc[ordinal] === undefined) return undefined
      return entryAt(ordinal)
    },

    distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number {
      if (ordToDoc[ordA] === undefined || ordToDoc[ordB] === undefined) return Number.POSITIVE_INFINITY

      if (simd) {
        const byteA = scratchByteLength + ordA * dimension * 4
        const byteB = scratchByteLength + ordB * dimension * 4
        return arenaFloat32Distance(simd, byteA, byteB, dimension, metric, mags[ordA], mags[ordB])
      }

      const baseA = scratchFloatLength + ordA * dimension
      const baseB = scratchFloatLength + ordB * dimension
      const a = arena.subarray(baseA, baseA + dimension)
      const b = arena.subarray(baseB, baseB + dimension)
      switch (metric) {
        case 'cosine':
          return 1 - cosineSimilarityWithMagnitudes(a, b, mags[ordA], mags[ordB])
        case 'dotProduct':
          return -dotProduct(a, b)
        case 'euclidean':
          return euclideanDistance(a, b)
      }
    },

    prepareQueryArena(query: Float32Array): ArenaQueryVector | null {
      if (!simd || dimension === 0 || query.length !== dimension) return null
      arena.set(query, 0)
      return { magnitude: simd.magnitude(0, dimension) }
    },

    distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number {
      if (!simd || ordinal < 0 || ordinal >= ordToDoc.length || ordToDoc[ordinal] === undefined) {
        return Number.POSITIVE_INFINITY
      }

      const byteOffset = scratchByteLength + ordinal * dimension * 4
      return arenaFloat32Distance(simd, 0, byteOffset, dimension, metric, prepared.magnitude, mags[ordinal])
    },

    exportSnapshot(): VectorStoreSnapshot {
      const slots = ordToDoc.length
      const vectors = new Float32Array(slots * dimension)
      if (slots > 0 && dimension > 0) {
        vectors.set(arena.subarray(scratchFloatLength, scratchFloatLength + slots * dimension))
      }
      const magnitudes = new Float64Array(slots)
      magnitudes.set(mags.subarray(0, Math.min(slots, mags.length)))
      const docIds: Array<string | null> = new Array(slots)
      for (let ord = 0; ord < slots; ord++) {
        docIds[ord] = ordToDoc[ord] ?? null
      }
      return { dimension, slots, vectors, magnitudes, docIds }
    },

    copySnapshotInto(vectors: Float32Array, magnitudes: Float64Array): void {
      const slots = ordToDoc.length
      if (slots > 0 && dimension > 0) {
        vectors.set(arena.subarray(scratchFloatLength, scratchFloatLength + slots * dimension))
      }
      magnitudes.set(mags.subarray(0, Math.min(slots, mags.length)))
    },

    restoreSnapshot(snapshot: VectorStoreSnapshot): void {
      docToOrd.clear()
      recycledOrds.clear()
      ordToDoc.length = 0
      partitionOf = new Int32Array(0)
      unknownPartitions = 0
      liveCount = 0
      capacity = 0
      dimension = 0
      scratchByteLength = 0
      scratchFloatLength = 0
      if (!simd) {
        arena = new Float32Array(0)
      }

      if (snapshot.dimension === 0 || snapshot.slots === 0) return

      initStorage(snapshot.dimension)
      ensureCapacity(snapshot.slots)

      arena.set(snapshot.vectors.subarray(0, snapshot.slots * snapshot.dimension), scratchFloatLength)

      mags.set(snapshot.magnitudes.subarray(0, Math.min(snapshot.slots, mags.length)))

      ensurePartitionSlots(snapshot.slots)
      for (let ord = 0; ord < snapshot.slots; ord++) {
        const docId = snapshot.docIds[ord]
        ordToDoc.push(docId ?? undefined)
        if (docId === null || docId === undefined) continue
        docToOrd.set(docId, ord)
        unknownPartitions += 1
        liveCount++
      }
    },

    estimateMemory(dimension: number): number {
      const count = liveCount
      if (count === 0) return 0

      const MAP_OVERHEAD = 64
      const MAP_ENTRY = 72
      const AVG_DOCID_BYTES = 56
      const MAGNITUDE_BYTES = 8
      const ORDINAL_SLOT = 16

      const perEntry = MAP_ENTRY + AVG_DOCID_BYTES + MAGNITUDE_BYTES + ORDINAL_SLOT
      return MAP_OVERHEAD + count * (perEntry + dimension * 4)
    },
  }
}
