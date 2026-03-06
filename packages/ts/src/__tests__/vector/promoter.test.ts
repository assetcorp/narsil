import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorSearchEngine, type VectorSearchEngine } from '../../search/vector-search'
import { createVectorPromoter, type VectorPromoter } from '../../vector/promoter'

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

describe('VectorPromoter', () => {
  const DIM = 4
  let promoter: VectorPromoter
  let engines: Map<string, VectorSearchEngine>

  beforeEach(() => {
    vi.useFakeTimers()
    engines = new Map()
  })

  afterEach(() => {
    promoter?.shutdown()
    vi.useRealTimers()
  })

  it('does not promote below threshold', () => {
    promoter = createVectorPromoter({ promotionThreshold: 100 })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 50; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    vi.runAllTimers()

    expect(engine.isPromoted).toBe(false)
  })

  it('promotes when threshold is reached', () => {
    promoter = createVectorPromoter({ promotionThreshold: 20 })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 25; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    vi.runAllTimers()

    expect(engine.isPromoted).toBe(true)
  })

  it('does not double-promote an already promoted engine', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10 })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    vi.runAllTimers()
    expect(engine.isPromoted).toBe(true)

    const hnswBefore = engine.getHNSWIndex()
    promoter.check(engines)
    vi.runAllTimers()
    expect(engine.getHNSWIndex()).toBe(hnswBefore)
  })

  it('promotes multiple fields independently', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10 })

    const engine1 = createVectorSearchEngine(DIM)
    const engine2 = createVectorSearchEngine(DIM)

    for (let i = 0; i < 15; i++) {
      engine1.insert(`doc${i}`, randomVector(DIM))
    }
    for (let i = 0; i < 5; i++) {
      engine2.insert(`doc${i}`, randomVector(DIM))
    }

    engines.set('field_a', engine1)
    engines.set('field_b', engine2)

    promoter.check(engines)
    vi.runAllTimers()

    expect(engine1.isPromoted).toBe(true)
    expect(engine2.isPromoted).toBe(false)
  })

  it('does not trigger promotion for a field already being promoted', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10 })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    promoter.check(engines)
    promoter.check(engines)

    vi.runAllTimers()
    expect(engine.isPromoted).toBe(true)
  })

  it('shutdown cancels pending promotions', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10 })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    promoter.shutdown()
    vi.runAllTimers()

    expect(engine.isPromoted).toBe(false)
  })

  it('uses default threshold of 10000', () => {
    promoter = createVectorPromoter()
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 100; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    vi.runAllTimers()

    expect(engine.isPromoted).toBe(false)
  })

  it('passes hnswConfig to the promoted engine', () => {
    promoter = createVectorPromoter({
      promotionThreshold: 5,
      hnswConfig: { m: 8, efConstruction: 64 },
    })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 10; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    vi.runAllTimers()

    expect(engine.isPromoted).toBe(true)
    const hnsw = engine.getHNSWIndex()
    expect(hnsw).not.toBeNull()
    expect(hnsw?.m).toBe(8)
    expect(hnsw?.efConstruction).toBe(64)
  })
})
