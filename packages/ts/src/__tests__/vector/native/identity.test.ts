import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { loadNativeCore } from '../../../vector/native/loader'
import {
  binaryBuilt,
  builtIndex,
  DOCUMENTS,
  hostBinary,
  METRICS,
  pointAtTheHostBinary,
  QUERIES,
  searchAll,
  WIDTHS,
} from './fixtures'

describe.skipIf(process.env.NARSIL_REQUIRE_NATIVE_CORE !== '1')('a job that requires the native search core', () => {
  it('finds the binary and loads it', () => {
    expect(binaryBuilt).toBe(true)
    process.env.NARSIL_NATIVE_CORE_PATH = hostBinary
    expect(loadNativeCore()).not.toBeNull()
  })
})

describe.skipIf(!binaryBuilt)('the native search core against the WebAssembly search', () => {
  let restorePath: () => void

  beforeAll(() => {
    restorePath = pointAtTheHostBinary()
  })

  afterAll(() => {
    restorePath()
  })

  afterEach(() => {
    setNativeSearchCoreEnabled(true)
  })

  for (const quantization of WIDTHS) {
    for (const metric of METRICS) {
      it(`returns the same documents and scores for ${quantization} under ${metric}`, async () => {
        const index = await builtIndex({ quantization, metric, native: false })
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
        const index = await builtIndex({ quantization, metric, native: false })
        try {
          const withoutRescoreDepth = 1
          const fromWebAssembly = searchAll(index, metric, false, withoutRescoreDepth)
          const fromNativeCore = searchAll(index, metric, true, withoutRescoreDepth)
          expect(fromNativeCore).toEqual(fromWebAssembly)
        } finally {
          index.dispose()
        }
      })

      it(`builds the same graph and the same records for ${quantization} under ${metric}`, async () => {
        const core = loadNativeCore()
        expect(core).not.toBeNull()
        if (core === null) return
        const placements = vi.spyOn(core, 'place')
        const quantised = vi.spyOn(core, 'quantise')
        const throughWebAssembly = await builtIndex({ quantization, metric, native: false })
        expect(placements).toHaveBeenCalledTimes(0)
        expect(quantised).toHaveBeenCalledTimes(0)
        const throughNativeCore = await builtIndex({ quantization, metric, native: true })
        const placed = placements.mock.results.filter(result => result.type === 'return' && result.value === 0).length
        const recordsWritten = quantised.mock.calls.length
        placements.mockRestore()
        quantised.mockRestore()
        try {
          expect(placed).toBe(DOCUMENTS)
          expect(recordsWritten > 0).toBe(quantization !== 'none')
          const fromNativeCore = throughNativeCore.serialize()[0]
          const fromWebAssembly = throughWebAssembly.serialize()[0]
          expect(fromNativeCore.graphs).toEqual(fromWebAssembly.graphs)
          expect(fromNativeCore.codes).toEqual(fromWebAssembly.codes)
        } finally {
          throughWebAssembly.dispose()
          throughNativeCore.dispose()
        }
      })
    }
  }

  it('estimates memory without attaching the core to a field', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const index = await builtIndex({ quantization: 'osq4', metric: 'cosine', native: false })
    setNativeSearchCoreEnabled(true)
    const graphAttachments = vi.spyOn(core, 'attachGraph')
    const storeAttachments = vi.spyOn(core, 'attachStore')
    try {
      expect(index.estimateMemoryBytes()).toBeGreaterThan(0)
      expect(graphAttachments).toHaveBeenCalledTimes(0)
      expect(storeAttachments).toHaveBeenCalledTimes(0)
    } finally {
      graphAttachments.mockRestore()
      storeAttachments.mockRestore()
      index.dispose()
    }
  })

  it('estimates the memory of whichever search backend serves the graph', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const index = await builtIndex({ quantization: 'osq4', metric: 'cosine', native: false })
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
