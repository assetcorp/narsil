import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { VectorQuantizationMode } from '../../../types/schema'
import type { VectorMetric } from '../../../vector/brute-force'
import { setNativeSearchCoreEnabled } from '../../../vector/native/field'
import { loadNativeCore } from '../../../vector/native/loader'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'

const DIMENSION = 53
const DOCUMENTS = 600
const QUERIES = 60
const hostBinary =
  process.env.NARSIL_NATIVE_CORE_PATH ??
  fileURLToPath(
    new URL(`../../../../../native/npm/${process.platform}-${process.arch}/narsil-core.node`, import.meta.url),
  )
const binaryBuilt = existsSync(hostBinary)

describe.skipIf(process.env.NARSIL_REQUIRE_NATIVE_CORE !== '1')('a job that requires the native search core', () => {
  it('finds the binary and loads it', () => {
    expect(binaryBuilt).toBe(true)
    process.env.NARSIL_NATIVE_CORE_PATH = hostBinary
    expect(loadNativeCore()).not.toBeNull()
  })
})

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function clusteredVectors(count: number, seed: number): Float32Array[] {
  const next = seededRandom(seed)
  const centres = Array.from({ length: 12 }, () => Float32Array.from({ length: DIMENSION }, () => next() * 2 - 1))
  return Array.from({ length: count }, () => {
    const centre = centres[Math.floor(next() * centres.length)]
    return Float32Array.from(centre, value => value + (next() - 0.5) * 0.6)
  })
}

async function builtIndex(quantization: VectorQuantizationMode, metric: VectorMetric, native: boolean) {
  setNativeSearchCoreEnabled(native)
  const random = seededRandom(20260918)
  const spy = vi.spyOn(Math, 'random').mockImplementation(random)
  const index = createVectorIndex('embedding', DIMENSION, {
    threshold: 50,
    quantization,
    hnswConfig: { m: 8, efConstruction: 60, metric },
  })
  const vectors = clusteredVectors(DOCUMENTS, 7)
  for (let i = 0; i < vectors.length; i++) index.insert(`doc-${String(i).padStart(4, '0')}`, vectors[i])
  index.scheduleBuild()
  await new Promise(resolve => setTimeout(resolve, 0))
  await index.awaitPendingBuild()
  spy.mockRestore()
  return index
}

function searchAll(index: VectorIndex, metric: VectorMetric, native: boolean, oversample?: number) {
  setNativeSearchCoreEnabled(native)
  return clusteredVectors(QUERIES, 99).map(query =>
    index
      .search(query, 10, { metric, minSimilarity: Number.NEGATIVE_INFINITY, oversample })
      .map(hit => [hit.docId, hit.score]),
  )
}

describe.skipIf(!binaryBuilt)('the native search core against the WebAssembly search', () => {
  const widths: VectorQuantizationMode[] = ['none', 'osq8', 'osq4', 'osq2', 'osq1']
  const metrics: VectorMetric[] = ['cosine', 'dotProduct', 'euclidean']
  let previousPath: string | undefined

  beforeAll(() => {
    previousPath = process.env.NARSIL_NATIVE_CORE_PATH
    process.env.NARSIL_NATIVE_CORE_PATH = hostBinary
  })

  afterAll(() => {
    if (previousPath === undefined) delete process.env.NARSIL_NATIVE_CORE_PATH
    else process.env.NARSIL_NATIVE_CORE_PATH = previousPath
  })

  afterEach(() => {
    setNativeSearchCoreEnabled(true)
  })

  for (const quantization of widths) {
    for (const metric of metrics) {
      it(`returns the same documents and scores for ${quantization} under ${metric}`, async () => {
        const index = await builtIndex(quantization, metric, false)
        try {
          expect(index.maintenanceStatus().graphCount).toBe(1)
          const core = loadNativeCore()
          expect(core).not.toBeNull()
          if (core === null) return
          const searches = vi.spyOn(core, 'search')
          const fromWebAssembly = searchAll(index, metric, false)
          expect(searches).toHaveBeenCalledTimes(0)
          const fromNativeCore = searchAll(index, metric, true)
          expect(searches).toHaveBeenCalledTimes(QUERIES)
          expect(searches.mock.results.every(result => result.type === 'return' && result.value > 0)).toBe(true)
          searches.mockRestore()
          expect(fromNativeCore).toEqual(fromWebAssembly)
          expect(fromNativeCore.every(hits => hits.length === 10)).toBe(true)
        } finally {
          index.dispose()
        }
      })

      it(`picks the same candidates by code for ${quantization} under ${metric}`, async () => {
        const index = await builtIndex(quantization, metric, false)
        try {
          const withoutRescoreDepth = 1
          const fromWebAssembly = searchAll(index, metric, false, withoutRescoreDepth)
          const fromNativeCore = searchAll(index, metric, true, withoutRescoreDepth)
          expect(fromNativeCore).toEqual(fromWebAssembly)
        } finally {
          index.dispose()
        }
      })

      it(`places every vector on the same neighbours for ${quantization} under ${metric}`, async () => {
        const core = loadNativeCore()
        expect(core).not.toBeNull()
        if (core === null) return
        const placements = vi.spyOn(core, 'place')
        const throughWebAssembly = await builtIndex(quantization, metric, false)
        expect(placements).toHaveBeenCalledTimes(0)
        const throughNativeCore = await builtIndex(quantization, metric, true)
        const placed = placements.mock.results.filter(result => result.type === 'return' && result.value >= 0).length
        placements.mockRestore()
        try {
          expect(placed).toBeGreaterThan(DOCUMENTS / 2)
          expect(throughNativeCore.serialize()[0].graphs).toEqual(throughWebAssembly.serialize()[0].graphs)
        } finally {
          throughWebAssembly.dispose()
          throughNativeCore.dispose()
        }
      })
    }
  }

  it('estimates the memory of whichever search backend serves the graph', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const index = await builtIndex('osq4', 'cosine', false)
    try {
      searchAll(index, 'cosine', false)
      const throughWebAssembly = index.estimateMemoryBytes()
      searchAll(index, 'cosine', true)
      const throughNativeCore = index.estimateMemoryBytes()
      const visitedMarksOfTheWebAssemblySearch = 1024 * 4
      expect(core.workspaceBytes()).toBeGreaterThan(DOCUMENTS * 4)
      expect(throughNativeCore - throughWebAssembly).toBeGreaterThanOrEqual(
        core.workspaceBytes() - visitedMarksOfTheWebAssemblySearch,
      )
    } finally {
      index.dispose()
    }
  })
})
