import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

describe('VectorIndex maintenance status', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('reports correct tombstoneRatio', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))
    index.remove('doc1')

    const status = index.maintenanceStatus()
    expect(status.tombstoneRatio).toBeCloseTo(0.5, 5)
  })

  it('reports correct bufferSize', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))

    expect(index.maintenanceStatus().bufferSize).toBe(2)
  })

  it('reports building=true during build', async () => {
    const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
    try {
      for (let i = 0; i < 150; i++) {
        buildIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      buildIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()

      expect(buildIndex.maintenanceStatus().building).toBe(true)

      while (buildIndex.maintenanceStatus().building) {
        await vi.advanceTimersToNextTimerAsync()
      }
      await buildIndex.awaitPendingBuild()

      expect(buildIndex.maintenanceStatus().building).toBe(false)
    } finally {
      buildIndex.dispose()
    }
  })

  it('reports graphCount=0 before build, 1 after', async () => {
    expect(index.maintenanceStatus().graphCount).toBe(0)

    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    expect(index.maintenanceStatus().graphCount).toBe(1)
  })
})

describe('VectorIndex memory estimation', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('returns 0 for empty index', () => {
    expect(index.estimateMemoryBytes()).toBe(0)
  })

  it('returns non-zero for populated index', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    expect(index.estimateMemoryBytes()).toBeGreaterThan(0)
  })

  it('increases with HNSW present', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }

    const memBefore = index.estimateMemoryBytes()

    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const memAfter = index.estimateMemoryBytes()
    expect(memAfter).toBeGreaterThan(memBefore)
  })

  it('includes SQ8 overhead when calibrated', async () => {
    const noSqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })

    try {
      for (let i = 0; i < 6; i++) {
        const v = normalizedVector(DIM)
        noSqIndex.insert(`doc${i}`, v)
        sqIndex.insert(`doc${i}`, new Float32Array(v))
      }

      noSqIndex.scheduleBuild()
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await noSqIndex.awaitPendingBuild()
      await sqIndex.awaitPendingBuild()

      expect(sqIndex.estimateMemoryBytes()).toBeGreaterThan(noSqIndex.estimateMemoryBytes())
    } finally {
      noSqIndex.dispose()
      sqIndex.dispose()
    }
  })
})

describe('VectorIndex scalar quantization integration', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('with quantization sq8, calibration happens during build', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
    try {
      for (let i = 0; i < 6; i++) {
        sqIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await sqIndex.awaitPendingBuild()

      const payload = sqIndex.serialize()
      expect(payload.sq8).not.toBeNull()
    } finally {
      sqIndex.dispose()
    }
  })

  it('with quantization none, no SQ8 is created', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const payload = index.serialize()
    expect(payload.sq8).toBeNull()
  })

  it('SQ8 data included in serialization when calibrated', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
    try {
      for (let i = 0; i < 6; i++) {
        sqIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await sqIndex.awaitPendingBuild()

      const payload = sqIndex.serialize()
      expect(payload.sq8).not.toBeNull()
      expect(typeof payload.sq8?.alpha).toBe('number')
      expect(typeof payload.sq8?.offset).toBe('number')
      expect(Object.keys(payload.sq8?.quantizedVectors ?? {}).length).toBe(6)
    } finally {
      sqIndex.dispose()
    }
  })
})
