import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WASM_PAGE_BYTES } from '../../../vector/constants'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

const QUANTISATION_VISIBLE_DIM = 1536

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
        buildIndex.insert(`doc${i}`, normalizedVector(DIM, i + 1))
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
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
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

  it('charges an empty field no block, because a field allocates one on its first vector', () => {
    const empty = index.estimateMemoryBytes()
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))

    expect(empty).toBeGreaterThan(0)
    expect(index.estimateMemoryBytes() - empty).toBeGreaterThanOrEqual(WASM_PAGE_BYTES)
  })

  it('charges a field nothing once it gives up its vectors', () => {
    index.insert('doc1', vectorFromValues(1, 0, 0, 0))
    index.dispose()

    expect(index.estimateMemoryBytes()).toBe(0)
  })

  it('increases with HNSW present', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }

    const memBefore = index.estimateMemoryBytes()

    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const memAfter = index.estimateMemoryBytes()
    expect(memAfter).toBeGreaterThan(memBefore)
  })

  it('charges the byte codes a quantised field keeps beside every vector', async () => {
    const noSqIndex = createVectorIndex('vec', QUANTISATION_VISIBLE_DIM, { threshold: 5, quantization: 'none' })
    const sqIndex = createVectorIndex('vec', QUANTISATION_VISIBLE_DIM, { threshold: 5, quantization: 'sq8' })
    const fixedNodeLevels = vi.spyOn(Math, 'random').mockReturnValue(0.5)

    try {
      for (let i = 0; i < 6; i++) {
        const v = normalizedVector(QUANTISATION_VISIBLE_DIM, i + 1)
        noSqIndex.insert(`doc${i}`, v)
        sqIndex.insert(`doc${i}`, new Float32Array(v))
      }

      noSqIndex.scheduleBuild()
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await noSqIndex.awaitPendingBuild()
      await sqIndex.awaitPendingBuild()

      const codeBytesForStoredVectors = 6 * QUANTISATION_VISIBLE_DIM
      expect(sqIndex.estimateMemoryBytes() - noSqIndex.estimateMemoryBytes()).toBeGreaterThanOrEqual(
        codeBytesForStoredVectors,
      )
    } finally {
      fixedNodeLevels.mockRestore()
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
        sqIndex.insert(`doc${i}`, normalizedVector(DIM, i + 1))
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
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
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
        sqIndex.insert(`doc${i}`, normalizedVector(DIM, i + 1))
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
