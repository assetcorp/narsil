import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, seededVector } from './fixtures'

const VECTORS = 40
const CONFIG = { m: 4, efConstruction: 32, metric: 'cosine' as const }

function buildGraph(): { store: VectorStore; index: HNSWIndex } {
  const store = createVectorStore()
  const index = createHNSWIndex(DIM, store, CONFIG)
  for (let i = 0; i < VECTORS; i++) insertVec(store, index, `doc${i}`, seededVector(DIM, i + 1))
  return { store, index }
}

function identityNumbers(count: number): Int32Array {
  return Int32Array.from({ length: count }, (_, i) => i)
}

function uint32At(bytes: Uint8Array, index: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(index * 4, true)
}

describe('an HNSW graph written with numbered vectors', () => {
  it('names every vector by the number the caller gives its ordinal', () => {
    const { index } = buildGraph()
    const shifted = Int32Array.from({ length: VECTORS }, (_, ordinal) => ordinal + 3)
    const ordinalOfNumber = new Int32Array(VECTORS + 3).fill(-1)
    for (let ordinal = 0; ordinal < VECTORS; ordinal++) ordinalOfNumber[ordinal + 3] = ordinal

    const graph = index.serializeNumbered(shifted, ordinalOfNumber)

    expect(graph.levels).toHaveLength(VECTORS + 3)
    expect([...graph.levels.subarray(0, 3)]).toEqual([0, 0, 0])
    expect(graph.levels.subarray(3).every(level => level >= 1)).toBe(true)
    expect(graph.entryPoint).not.toBeNull()
    expect(graph.entryPoint).toBeGreaterThanOrEqual(3)
    const firstCount = uint32At(graph.neighbours, 0)
    expect(firstCount).toBeGreaterThan(0)
    for (let i = 1; i <= firstCount; i++) expect(uint32At(graph.neighbours, i)).toBeGreaterThanOrEqual(3)
  })

  it('restores the same search results on a store that numbers its ordinals differently', () => {
    const { index } = buildGraph()
    const numbers = identityNumbers(VECTORS)
    const graph = index.serializeNumbered(numbers, numbers)

    const reordered = createVectorStore()
    const ordinalOfNumber = new Int32Array(VECTORS)
    reordered.insert('padding', seededVector(DIM, 999))
    for (let number = 0; number < VECTORS; number++) {
      ordinalOfNumber[number] = reordered.insert(`doc${number}`, seededVector(DIM, number + 1))
    }
    const restored = createHNSWIndex(DIM, reordered, CONFIG)
    restored.deserializeNumbered(graph, ordinalOfNumber)

    expect(restored.size).toBe(VECTORS)
    expect(restored.entryPointId).toBe(index.entryPointId)
    const query = seededVector(DIM, 77)
    const expected = index.search(query, 5, 'cosine', 0).map(result => result.docId)
    expect(restored.search(query, 5, 'cosine', 0).map(result => result.docId)).toEqual(expected)
  })

  it('leaves out a vector with no number and every link to it', () => {
    const { index } = buildGraph()
    const numberOfOrdinal = identityNumbers(VECTORS)
    numberOfOrdinal[5] = -1
    const ordinalOfNumber = identityNumbers(VECTORS)
    ordinalOfNumber[5] = -1

    const graph = index.serializeNumbered(numberOfOrdinal, ordinalOfNumber)

    expect(graph.levels[5]).toBe(0)
    const values = graph.neighbours.byteLength / 4
    let cursor = 0
    for (let number = 0; number < VECTORS; number++) {
      for (let layer = 0; layer < graph.levels[number]; layer++) {
        const count = uint32At(graph.neighbours, cursor)
        for (let i = 1; i <= count; i++) expect(uint32At(graph.neighbours, cursor + i)).not.toBe(5)
        cursor += count + 1
      }
    }
    expect(cursor).toBe(values)
  })

  it('skips a dead vector and a link to a vector that holds no node when it reads a graph', () => {
    const { index, store } = buildGraph()
    const numbers = identityNumbers(VECTORS)
    const graph = index.serializeNumbered(numbers, numbers)
    const ordinalOfNumber = identityNumbers(VECTORS)
    ordinalOfNumber[7] = -1

    const restored = createHNSWIndex(DIM, store, CONFIG)
    restored.deserializeNumbered(graph, ordinalOfNumber)

    expect(restored.size).toBe(VECTORS - 1)
    expect(restored.has('doc7')).toBe(false)
    const found = restored.search(seededVector(DIM, 8), VECTORS, 'cosine', 0).map(result => result.docId)
    expect(found).not.toContain('doc7')
  })

  it('refuses a graph whose neighbours end inside a list', () => {
    const { index, store } = buildGraph()
    const numbers = identityNumbers(VECTORS)
    const graph = index.serializeNumbered(numbers, numbers)
    const truncated = { ...graph, neighbours: graph.neighbours.subarray(0, graph.neighbours.byteLength - 4) }

    const restored = createHNSWIndex(DIM, store, CONFIG)
    let thrown: unknown
    try {
      restored.deserializeNumbered(truncated, numbers)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(NarsilError)
    expect((thrown as NarsilError).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
  })

  it('starts from a node on the highest layer when the entry point names a vector with no node', () => {
    const { index, store } = buildGraph()
    const numbers = identityNumbers(VECTORS)
    const graph = { ...index.serializeNumbered(numbers, numbers), entryPoint: null }

    const restored = createHNSWIndex(DIM, store, CONFIG)
    restored.deserializeNumbered(graph, numbers)

    expect(restored.entryPointId).not.toBeNull()
    expect(restored.search(seededVector(DIM, 3), 3, 'cosine', 0)).toHaveLength(3)
  })
})
