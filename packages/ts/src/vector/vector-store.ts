import { magnitude } from './similarity'

export interface VectorStoreEntry {
  vector: Float32Array
  magnitude: number
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
}

export function createVectorStore(): VectorStore {
  const vectors = new Map<string, VectorStoreEntry>()

  return {
    get size() {
      return vectors.size
    },

    insert(docId: string, vector: Float32Array): void {
      const mag = magnitude(vector)
      vectors.set(docId, { vector, magnitude: mag })
    },

    remove(docId: string): void {
      vectors.delete(docId)
    },

    get(docId: string): VectorStoreEntry | undefined {
      return vectors.get(docId)
    },

    has(docId: string): boolean {
      return vectors.has(docId)
    },

    entries(): IterableIterator<[string, VectorStoreEntry]> {
      return vectors.entries()
    },

    clear(): void {
      vectors.clear()
    },

    estimateMemory(dimension: number): number {
      const count = vectors.size
      if (count === 0) return 0

      const MAP_OVERHEAD = 64
      const MAP_ENTRY = 72
      const ENTRY_OBJ = 32
      const AVG_DOCID_BYTES = 56
      const TYPED_ARRAY_HEADER = 64
      const MAGNITUDE_BYTES = 8

      const perEntry = MAP_ENTRY + ENTRY_OBJ + AVG_DOCID_BYTES + TYPED_ARRAY_HEADER + MAGNITUDE_BYTES
      return MAP_OVERHEAD + count * (perEntry + dimension * 4)
    },
  }
}
