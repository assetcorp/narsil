import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

describe('VectorIndex build scheduling', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('scheduleBuild does nothing when below threshold', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.scheduleBuild()

    const status = index.maintenanceStatus()
    expect(status.graphCount).toBe(0)
    expect(status.building).toBe(false)
  })

  it('scheduleBuild does nothing when already building', async () => {
    const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
    try {
      for (let i = 0; i < 150; i++) {
        buildIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      buildIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()

      const status = buildIndex.maintenanceStatus()
      expect(status.building).toBe(true)

      buildIndex.scheduleBuild()

      while (buildIndex.maintenanceStatus().building) {
        await vi.advanceTimersToNextTimerAsync()
      }
      await buildIndex.awaitPendingBuild()

      expect(buildIndex.maintenanceStatus().graphCount).toBe(1)
    } finally {
      buildIndex.dispose()
    }
  })

  it('scheduleBuild does nothing when disposed', () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.dispose()
    index.scheduleBuild()

    const status = index.maintenanceStatus()
    expect(status.graphCount).toBe(0)
  })

  it('triggerBuild creates HNSW from live docs excluding tombstones', async () => {
    for (let i = 0; i < 8; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.remove('doc0')
    index.remove('doc1')

    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    expect(index.maintenanceStatus().graphCount).toBe(1)

    const results = index.search(normalizedVector(DIM), 10, {
      metric: 'cosine',
      minSimilarity: 0,
    })
    const docIds = results.map(r => r.docId)
    expect(docIds).not.toContain('doc0')
    expect(docIds).not.toContain('doc1')
  })

  it('awaitPendingBuild waits for build to complete', async () => {
    const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
    try {
      for (let i = 0; i < 150; i++) {
        buildIndex.insert(`doc${i}`, normalizedVector(DIM))
      }
      buildIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()

      expect(buildIndex.maintenanceStatus().building).toBe(true)

      const awaitPromise = buildIndex.awaitPendingBuild()
      while (buildIndex.maintenanceStatus().building) {
        await vi.advanceTimersToNextTimerAsync()
      }
      await awaitPromise

      expect(buildIndex.maintenanceStatus().building).toBe(false)
      expect(buildIndex.maintenanceStatus().graphCount).toBe(1)
    } finally {
      buildIndex.dispose()
    }
  })

  it('awaitPendingBuild returns immediately when no build pending', async () => {
    await index.awaitPendingBuild()
    expect(index.maintenanceStatus().building).toBe(false)
  })
})

describe('VectorIndex dispose', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('dispose prevents new builds', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM))
    }
    index.dispose()
    index.scheduleBuild()

    await vi.advanceTimersToNextTimerAsync()
    expect(index.maintenanceStatus().graphCount).toBe(0)
  })

  it('dispose during build does not produce an HNSW graph', async () => {
    const buildIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'none' })
    for (let i = 0; i < 150; i++) {
      buildIndex.insert(`doc${i}`, normalizedVector(DIM))
    }
    buildIndex.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()

    expect(buildIndex.maintenanceStatus().building).toBe(true)

    buildIndex.dispose()

    while (buildIndex.maintenanceStatus().building) {
      await vi.advanceTimersToNextTimerAsync()
    }
    await buildIndex.awaitPendingBuild()

    expect(buildIndex.maintenanceStatus().graphCount).toBe(0)
  })
})
