import { describe, expect, it } from 'vitest'
import { createVectorSearchEngine } from '../../search/vector-search'

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

describe('VectorSearchEngine auto-promotion', () => {
  const DIM = 4

  it('does not promote below threshold', () => {
    const engine = createVectorSearchEngine(DIM, undefined, { threshold: 100 })
    for (let i = 0; i < 50; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    expect(engine.isPromoted).toBe(false)
  })

  it('promotes when threshold is reached', () => {
    const engine = createVectorSearchEngine(DIM, undefined, { threshold: 20 })
    for (let i = 0; i < 25; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    expect(engine.isPromoted).toBe(true)
  })

  it('does not re-promote an already promoted engine', () => {
    const engine = createVectorSearchEngine(DIM, undefined, { threshold: 10 })
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    expect(engine.isPromoted).toBe(true)

    const hnswBefore = engine.getHNSWIndex()
    for (let i = 15; i < 25; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    expect(engine.getHNSWIndex()).toBe(hnswBefore)
  })

  it('uses default threshold of 1024', () => {
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 100; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    expect(engine.isPromoted).toBe(false)
  })

  it('passes hnswConfig to the promoted engine', () => {
    const engine = createVectorSearchEngine(
      DIM,
      { m: 8, efConstruction: 64 },
      { threshold: 5, hnswConfig: { m: 8, efConstruction: 64 } },
    )
    for (let i = 0; i < 10; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }

    expect(engine.isPromoted).toBe(true)
    const hnsw = engine.getHNSWIndex()
    expect(hnsw).not.toBeNull()
    expect(hnsw?.m).toBe(8)
    expect(hnsw?.efConstruction).toBe(64)
  })

  it('produces correct search results after auto-promotion', () => {
    const engine = createVectorSearchEngine(DIM, undefined, { threshold: 10 })

    engine.insert('target', new Float32Array([1, 0, 0, 0]))
    engine.insert('opposite', new Float32Array([0, 0, 0, 1]))
    for (let i = 0; i < 12; i++) {
      engine.insert(`filler${i}`, randomVector(DIM))
    }

    expect(engine.isPromoted).toBe(true)

    const results = engine.search(new Float32Array([0.95, 0.05, 0, 0]), 1, 'cosine', 0)
    expect(results[0].docId).toBe('target')
  })

  it('inserts go directly into HNSW after promotion', () => {
    const engine = createVectorSearchEngine(DIM, undefined, { threshold: 10 })
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    expect(engine.isPromoted).toBe(true)

    engine.insert('late_doc', randomVector(DIM))
    expect(engine.has('late_doc')).toBe(true)

    const hnsw = engine.getHNSWIndex()
    expect(hnsw?.has('late_doc')).toBe(true)
  })

  it('removal with tombstone works after promotion', () => {
    const engine = createVectorSearchEngine(DIM, undefined, { threshold: 10 })
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    expect(engine.isPromoted).toBe(true)

    engine.remove('doc0')
    expect(engine.has('doc0')).toBe(false)
    expect(engine.size).toBe(14)
  })
})
