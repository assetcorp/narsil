import type { VectorMetric } from './brute-force'
import { type ArenaSimd, createArenaSimd } from './simd'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from './similarity'

export interface VectorStoreEntry {
  vector: Float32Array
  magnitude: number
}

export interface ArenaQueryVector {
  readonly magnitude: number
}

/**
 * Every stored vector in the form the engine hands to another thread.
 *
 * @internal
 */
export interface VectorStoreSnapshot {
  /** Each vector carries this many components. */
  dimension: number
  /** The store spans this many ordinals, deleted ones included. */
  slots: number
  /** This holds every vector end to end, `slots * dimension` components long. */
  vectors: Float32Array
  /** Each ordinal's vector length, so a reader need not recompute it. */
  magnitudes: Float64Array
  /** The document at each ordinal, `null` where the ordinal holds none. */
  docIds: Array<string | null>
}

export interface VectorStore {
  readonly size: number
  insert(docId: string, vector: Float32Array): void
  remove(docId: string): void
  get(docId: string): VectorStoreEntry | undefined
  has(docId: string): boolean
  entries(): IterableIterator<[string, VectorStoreEntry]>
  clear(): void
  estimateMemory(dimension: number): number
  getOrdinal(docId: string): number | undefined
  docIdForOrdinal(ordinal: number): string | undefined
  entryForOrdinal(ordinal: number): VectorStoreEntry | undefined
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
  prepareQueryArena(query: Float32Array): ArenaQueryVector | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
  exportSnapshot(): VectorStoreSnapshot
  restoreSnapshot(snapshot: VectorStoreSnapshot): void
}

const INITIAL_CAPACITY = 16
const PAGE_BYTES = 65536

export function createVectorStore(): VectorStore {
  const docToOrd = new Map<string, number>()
  const recycledOrds = new Map<string, number>()
  const ordToDoc: Array<string | undefined> = []
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
    let newCap = capacity === 0 ? INITIAL_CAPACITY : capacity
    while (newCap < needed) newCap *= 2

    const nextMags = new Float64Array(newCap)
    nextMags.set(mags)
    mags = nextMags

    if (simd) {
      const requiredBytes = scratchByteLength + newCap * dimension * 4
      const have = simd.memory.buffer.byteLength
      if (requiredBytes > have) {
        try {
          simd.memory.grow(Math.ceil((requiredBytes - have) / PAGE_BYTES))
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

  return {
    get size() {
      return liveCount
    },

    insert(docId: string, vector: Float32Array): void {
      if (dimension === 0) initStorage(vector.length)

      const existing = docToOrd.get(docId)
      if (existing !== undefined) {
        writeVector(existing, vector)
        return
      }
      const recycled = recycledOrds.get(docId)
      if (recycled !== undefined) {
        recycledOrds.delete(docId)
        docToOrd.set(docId, recycled)
        ordToDoc[recycled] = docId
        ensureCapacity(recycled + 1)
        writeVector(recycled, vector)
        liveCount++
        return
      }
      const ord = ordToDoc.length
      docToOrd.set(docId, ord)
      ordToDoc.push(docId)
      ensureCapacity(ord + 1)
      writeVector(ord, vector)
      liveCount++
    },

    remove(docId: string): void {
      const ord = docToOrd.get(docId)
      if (ord === undefined) return
      docToOrd.delete(docId)
      ordToDoc[ord] = undefined
      recycledOrds.set(docId, ord)
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
        if (metric === 'euclidean') {
          return Math.sqrt(simd.squared_euclidean_distance(byteA, byteB, dimension))
        }
        const dot = simd.dot_product(byteA, byteB, dimension)
        if (metric === 'dotProduct') return -dot
        const magA = mags[ordA]
        const magB = mags[ordB]
        if (magA === 0 || magB === 0) return 1
        return 1 - dot / (magA * magB)
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
      if (metric === 'euclidean') {
        return Math.sqrt(simd.squared_euclidean_distance(0, byteOffset, dimension))
      }

      const dot = simd.dot_product(0, byteOffset, dimension)
      if (metric === 'dotProduct') return -dot

      const vecMag = mags[ordinal]
      if (prepared.magnitude === 0 || vecMag === 0) return 1
      return 1 - dot / (prepared.magnitude * vecMag)
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

    restoreSnapshot(snapshot: VectorStoreSnapshot): void {
      docToOrd.clear()
      recycledOrds.clear()
      ordToDoc.length = 0
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

      for (let ord = 0; ord < snapshot.slots; ord++) {
        const docId = snapshot.docIds[ord]
        ordToDoc.push(docId ?? undefined)
        if (docId === null || docId === undefined) continue
        docToOrd.set(docId, ord)
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
