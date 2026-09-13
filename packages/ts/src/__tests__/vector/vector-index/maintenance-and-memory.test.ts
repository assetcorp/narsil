import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WASM_PAGE_BYTES } from '../../../vector/constants'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector, vectorFromValues } from './fixtures'

const QUANTIZATION_VISIBLE_DIM = 1536

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

  it('charges the code records a quantized field keeps for every vector', async () => {
    const noSqIndex = createVectorIndex('vec', QUANTIZATION_VISIBLE_DIM, { threshold: 5, quantization: 'none' })
    const sqIndex = createVectorIndex('vec', QUANTIZATION_VISIBLE_DIM, { threshold: 5, quantization: 'osq8' })
    const fixedNodeLevels = vi.spyOn(Math, 'random').mockReturnValue(0.5)

    try {
      for (let i = 0; i < 6; i++) {
        const v = normalizedVector(QUANTIZATION_VISIBLE_DIM, i + 1)
        noSqIndex.insert(`doc${i}`, v)
        sqIndex.insert(`doc${i}`, new Float32Array(v))
      }

      noSqIndex.scheduleBuild()
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await noSqIndex.awaitPendingBuild()
      await sqIndex.awaitPendingBuild()

      const codeBytesForStoredVectors = 6 * QUANTIZATION_VISIBLE_DIM
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

describe('VectorIndex quantization integration', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  it('calibrates and writes one record per vector during the build', async () => {
    const sqIndex = createVectorIndex('vec', DIM, { threshold: 5, quantization: 'osq8' })
    try {
      for (let i = 0; i < 6; i++) {
        sqIndex.insert(`doc${i}`, normalizedVector(DIM, i + 1))
      }
      sqIndex.scheduleBuild()
      await vi.advanceTimersToNextTimerAsync()
      await sqIndex.awaitPendingBuild()

      const [part] = sqIndex.serialize()
      expect(part.codes).not.toBeNull()
      expect(part.codes?.bits).toBe(8)
      expect(part.codes?.centroid).toHaveLength(DIM)
      expect(part.codes?.records.byteLength).toBe(6 * (DIM + 16))
    } finally {
      sqIndex.dispose()
    }
  })

  it('with quantization none, no codes are written', async () => {
    for (let i = 0; i < 6; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    }
    index.scheduleBuild()
    await vi.advanceTimersToNextTimerAsync()
    await index.awaitPendingBuild()

    const [part] = index.serialize()
    expect(part.codes).toBeNull()
  })

  it('takes the quantization the dimension calls for when the configuration names none', () => {
    const wide = createVectorIndex('vec', 1536, { threshold: 5 })
    const middle = createVectorIndex('vec', 768, { threshold: 5 })
    const narrow = createVectorIndex('vec', 128, { threshold: 5 })
    try {
      expect(wide.quantization).toBe('osq1')
      expect(middle.quantization).toBe('osq4')
      expect(narrow.quantization).toBe('osq8')
    } finally {
      wide.dispose()
      middle.dispose()
      narrow.dispose()
    }
  })
})
