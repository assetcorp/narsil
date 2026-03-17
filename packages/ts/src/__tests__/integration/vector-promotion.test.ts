import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../core/partition'
import { getLanguage } from '../../languages/registry'
import type { SchemaDefinition } from '../../types/schema'

const DIM = 4
const schema: SchemaDefinition = {
  title: 'string',
  embedding: `vector[${DIM}]`,
}
const language = getLanguage('english')

function randomVector(): Float32Array {
  const v = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

describe('VectorPromoter wired into PartitionIndex', () => {
  it('auto-promotes vector field when threshold is exceeded', async () => {
    vi.useFakeTimers()

    const partition = createPartitionIndex(0, true, { threshold: 50 })

    for (let i = 0; i < 60; i++) {
      partition.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    vi.runAllTimers()
    vi.useRealTimers()

    const result = partition.searchVector({
      field: 'embedding',
      value: Array.from(randomVector()),
      k: 5,
      metric: 'cosine',
    })

    expect(result.scored.length).toBeGreaterThan(0)
    expect(result.scored.length).toBeLessThanOrEqual(5)
  })

  it('does not promote when below threshold', () => {
    vi.useFakeTimers()

    const partition = createPartitionIndex(0, true, { threshold: 100 })

    for (let i = 0; i < 30; i++) {
      partition.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    vi.runAllTimers()
    vi.useRealTimers()

    const result = partition.searchVector({
      field: 'embedding',
      value: Array.from(randomVector()),
      k: 5,
      metric: 'cosine',
    })

    expect(result.scored.length).toBeGreaterThan(0)
  })

  it('works without vectorPromotion config (no auto-promotion)', () => {
    const partition = createPartitionIndex(0, true)

    for (let i = 0; i < 20; i++) {
      partition.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    const result = partition.searchVector({
      field: 'embedding',
      value: Array.from(randomVector()),
      k: 5,
      metric: 'cosine',
    })

    expect(result.scored.length).toBeGreaterThan(0)
  })

  it('search finds the nearest vector after auto-promotion', async () => {
    vi.useFakeTimers()

    const partition = createPartitionIndex(0, true, { threshold: 10 })

    const target = vectorFromValues(1, 0, 0, 0)
    partition.insert('nearest', { title: 'nearest', embedding: vectorFromValues(0.95, 0.05, 0, 0) }, schema, language)
    partition.insert('furthest', { title: 'furthest', embedding: vectorFromValues(0, 0, 0, 1) }, schema, language)

    for (let i = 0; i < 15; i++) {
      partition.insert(`filler${i}`, { title: `filler ${i}`, embedding: randomVector() }, schema, language)
    }

    vi.runAllTimers()
    vi.useRealTimers()

    const result = partition.searchVector({
      field: 'embedding',
      value: Array.from(target),
      k: 1,
      metric: 'cosine',
    })

    expect(result.scored).toHaveLength(1)
    expect(result.scored[0].docId).toBe('nearest')
  })

  it('efSearch parameter reaches the search layer', async () => {
    vi.useFakeTimers()

    const partition = createPartitionIndex(0, true, { threshold: 10 })

    for (let i = 0; i < 20; i++) {
      partition.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    vi.runAllTimers()
    vi.useRealTimers()

    const result = partition.searchVector({
      field: 'embedding',
      value: Array.from(randomVector()),
      k: 3,
      metric: 'cosine',
      efSearch: 100,
    })

    expect(result.scored.length).toBeGreaterThan(0)
    expect(result.scored.length).toBeLessThanOrEqual(3)
  })

  it('clear shuts down the promoter cleanly', () => {
    vi.useFakeTimers()

    const partition = createPartitionIndex(0, true, { threshold: 10 })

    for (let i = 0; i < 15; i++) {
      partition.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    partition.clear()
    vi.runAllTimers()
    vi.useRealTimers()

    expect(partition.count()).toBe(0)
  })
})

describe('HNSW serialization through partition layer', () => {
  function buildPopulatedPartition(count: number, threshold: number): PartitionIndex {
    vi.useFakeTimers()
    const partition = createPartitionIndex(0, true, { threshold })

    for (let i = 0; i < count; i++) {
      partition.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    vi.runAllTimers()
    vi.useRealTimers()
    return partition
  }

  it('serialization round-trip preserves HNSW graph when promoted', () => {
    const original = buildPopulatedPartition(30, 10)

    const serialized = original.serialize('test-index', 1, 'english', schema)
    expect(serialized.vectorData.embedding).toBeDefined()
    expect(serialized.vectorData.embedding.hnswGraph).not.toBeNull()
    expect(serialized.vectorData.embedding.vectors).toHaveLength(30)

    const restored = createPartitionIndex(0, true, { threshold: 10 })
    restored.deserialize(serialized, schema)

    expect(restored.count()).toBe(30)

    const query = Array.from(randomVector())
    const originalResults = original.searchVector({ field: 'embedding', value: query, k: 5, metric: 'cosine' })
    const restoredResults = restored.searchVector({ field: 'embedding', value: query, k: 5, metric: 'cosine' })

    expect(restoredResults.scored.length).toBe(originalResults.scored.length)

    const originalIds = new Set(originalResults.scored.map(s => s.docId))
    const restoredIds = new Set(restoredResults.scored.map(s => s.docId))
    for (const id of originalIds) {
      expect(restoredIds).toContain(id)
    }
  })

  it('serialization round-trip without HNSW (below threshold)', () => {
    const original = createPartitionIndex(0, true, { threshold: 100 })
    for (let i = 0; i < 10; i++) {
      original.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    const serialized = original.serialize('test-index', 1, 'english', schema)
    expect(serialized.vectorData.embedding.hnswGraph).toBeNull()

    const restored = createPartitionIndex(0, true, { threshold: 100 })
    restored.deserialize(serialized, schema)

    expect(restored.count()).toBe(10)

    const result = restored.searchVector({
      field: 'embedding',
      value: Array.from(randomVector()),
      k: 3,
      metric: 'cosine',
    })
    expect(result.scored.length).toBeGreaterThan(0)
  })

  it('HNSW config propagates through partition creation', () => {
    vi.useFakeTimers()

    const partition = createPartitionIndex(0, true, {
      threshold: 5,
      hnswConfig: { m: 8, efConstruction: 64 },
    })

    for (let i = 0; i < 10; i++) {
      partition.insert(`doc${i}`, { title: `item ${i}`, embedding: randomVector() }, schema, language)
    }

    vi.runAllTimers()
    vi.useRealTimers()

    const serialized = partition.serialize('test-index', 1, 'english', schema)
    const graph = serialized.vectorData.embedding.hnswGraph
    expect(graph).not.toBeNull()
    expect(graph?.m).toBe(8)
    expect(graph?.efConstruction).toBe(64)
  })
})
