import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorSearchEngine, type VectorSearchEngine } from '../../search/vector-search'
import {
  createVectorPromoter,
  detectWorkerStrategy,
  type VectorPromoter,
  type WorkerStrategy,
} from '../../vector/promoter'

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

describe('detectWorkerStrategy', () => {
  it('returns a valid strategy for the current runtime', () => {
    const strategy = detectWorkerStrategy()
    expect(['worker-threads', 'web-worker', 'synchronous']).toContain(strategy)
  })
})

describe('VectorPromoter with synchronous strategy', () => {
  const DIM = 4
  let promoter: VectorPromoter
  let engines: Map<string, VectorSearchEngine>

  beforeEach(() => {
    engines = new Map()
  })

  afterEach(() => {
    promoter?.shutdown()
  })

  it('reports the configured strategy', () => {
    promoter = createVectorPromoter({ workerStrategy: 'synchronous' })
    expect(promoter.strategy).toBe('synchronous')
  })

  it('does not promote below threshold', () => {
    promoter = createVectorPromoter({ promotionThreshold: 100, workerStrategy: 'synchronous' })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 50; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)

    expect(engine.isPromoted).toBe(false)
  })

  it('promotes immediately when threshold is reached', () => {
    promoter = createVectorPromoter({ promotionThreshold: 20, workerStrategy: 'synchronous' })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 25; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)

    expect(engine.isPromoted).toBe(true)
  })

  it('does not double-promote an already promoted engine', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10, workerStrategy: 'synchronous' })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    expect(engine.isPromoted).toBe(true)

    const hnswBefore = engine.getHNSWIndex()
    promoter.check(engines)
    expect(engine.getHNSWIndex()).toBe(hnswBefore)
  })

  it('promotes multiple fields independently', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10, workerStrategy: 'synchronous' })

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

    expect(engine1.isPromoted).toBe(true)
    expect(engine2.isPromoted).toBe(false)
  })

  it('uses default threshold of 10000', () => {
    promoter = createVectorPromoter({ workerStrategy: 'synchronous' })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 100; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)

    expect(engine.isPromoted).toBe(false)
  })

  it('passes hnswConfig to the promoted engine', () => {
    promoter = createVectorPromoter({
      promotionThreshold: 5,
      hnswConfig: { m: 8, efConstruction: 64 },
      workerStrategy: 'synchronous',
    })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 10; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)

    expect(engine.isPromoted).toBe(true)
    const hnsw = engine.getHNSWIndex()
    expect(hnsw).not.toBeNull()
    expect(hnsw?.m).toBe(8)
    expect(hnsw?.efConstruction).toBe(64)
  })

  it('produces correct search results after synchronous promotion', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10, workerStrategy: 'synchronous' })
    const engine = createVectorSearchEngine(DIM)

    engine.insert('target', new Float32Array([1, 0, 0, 0]))
    engine.insert('opposite', new Float32Array([0, 0, 0, 1]))
    for (let i = 0; i < 12; i++) {
      engine.insert(`filler${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    expect(engine.isPromoted).toBe(true)

    const results = engine.search(new Float32Array([0.95, 0.05, 0, 0]), 1, 'cosine')
    expect(results[0].docId).toBe('target')
  })
})

describe('VectorPromoter with worker-threads strategy', () => {
  const DIM = 4
  let promoter: VectorPromoter
  let engines: Map<string, VectorSearchEngine>

  beforeEach(() => {
    engines = new Map()
  })

  afterEach(() => {
    promoter?.shutdown()
  })

  it('can spawn a worker thread and receive a response', async () => {
    const wt = await import('node:worker_threads')
    const workerUrl = import.meta.url.replace(/\/src\/.*$/, '/dist/vector/hnsw-build-worker.mjs')
    const worker = new wt.Worker(new URL(workerUrl))

    const result = await new Promise<{ type: string }>((resolve, reject) => {
      worker.on('message', (msg: unknown) => { worker.terminate(); resolve(msg as { type: string }) })
      worker.on('error', (err: unknown) => { worker.terminate(); reject(err) })
      worker.postMessage({
        type: 'build',
        vectors: [{ docId: 'a', values: [1, 0, 0, 0] }, { docId: 'b', values: [0, 1, 0, 0] }],
        dimension: 4,
        config: {},
      })
    })

    expect(result.type).toBe('success')
  }, 10_000)

  it('promotes via worker thread and completes asynchronously', async () => {
    promoter = createVectorPromoter({ promotionThreshold: 10, workerStrategy: 'worker-threads' })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)

    expect(engine.isPromoted).toBe(false)

    const deadline = Date.now() + 10_000
    while (!engine.isPromoted && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    expect(engine.isPromoted).toBe(true)
    const results = engine.search(randomVector(DIM), 3, 'cosine')
    expect(results.length).toBeGreaterThan(0)
  }, 15_000)

  it('shutdown terminates pending worker builds', () => {
    promoter = createVectorPromoter({ promotionThreshold: 10, workerStrategy: 'worker-threads' })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    promoter.shutdown()

    expect(engine.isPromoted).toBe(false)
  })

  it('does not start a second worker for a field already being built', async () => {
    promoter = createVectorPromoter({ promotionThreshold: 10, workerStrategy: 'worker-threads' })
    const engine = createVectorSearchEngine(DIM)
    for (let i = 0; i < 15; i++) {
      engine.insert(`doc${i}`, randomVector(DIM))
    }
    engines.set('embeddings', engine)

    promoter.check(engines)
    promoter.check(engines)
    promoter.check(engines)

    const deadline = Date.now() + 10_000
    while (!engine.isPromoted && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    expect(engine.isPromoted).toBe(true)
  }, 15_000)
})
