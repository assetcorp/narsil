import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

describe('VectorIndex compact', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('compact removes tombstoned docs from store', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.insert('doc2', vectorFromValues(0, 1, 0, 0))
    index.remove('doc1')

    expect(index.maintenanceStatus().tombstoneRatio).toBeGreaterThan(0)

    index.compact()

    expect(index.maintenanceStatus().tombstoneRatio).toBe(0)
    expect(index.has('doc1')).toBe(false)
    expect(index.has('doc2')).toBe(true)
    expect(index.size).toBe(1)
  })

  it('compact recalibrates SQ8 when calibrated', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
    try {
      for (let i = 0; i < 6; i++) {
        sqIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await sqIndex.awaitPendingBuild()

      sqIndex.remove('doc0')
      sqIndex.remove('doc1')
      sqIndex.compact()

      expect(sqIndex.maintenanceStatus().tombstoneRatio).toBe(0)
      expect(sqIndex.size).toBe(4)
    } finally {
      sqIndex.dispose()
    }
  })

  it('compact is a no-op when no tombstones', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    const sizeBefore = index.size
    index.compact()
    expect(index.size).toBe(sizeBefore)
  })
})

describe('VectorIndex optimize', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('optimize compacts then rebuilds HNSW', async () => {
    for (let i = 0; i < 8; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.remove('doc0')

    await index.optimize()

    expect(index.maintenanceStatus().graphCount).toBe(1)
    expect(index.maintenanceStatus().tombstoneRatio).toBe(0)
    expect(index.maintenanceStatus().bufferSize).toBe(0)
  })

  it('optimize with empty index clears HNSW and buffer', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    for (let i = 0; i < 6; i++) {
      index.remove(`doc${i}`)
    }

    await index.optimize()

    expect(index.maintenanceStatus().graphCount).toBe(0)
    expect(index.maintenanceStatus().bufferSize).toBe(0)
    expect(index.size).toBe(0)
  })

  it('optimize recalibrates SQ8', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'sq8' })
    try {
      for (let i = 0; i < 6; i++) {
        sqIndex.insert(`doc${i}`, normalizedVector(DIM))
      }

      await sqIndex.optimize()

      expect(sqIndex.maintenanceStatus().graphCount).toBe(1)
      expect(sqIndex.maintenanceStatus().bufferSize).toBe(0)
    } finally {
      sqIndex.dispose()
    }
  })
})
