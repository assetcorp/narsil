import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { VectorQuantizationMode } from '../../../types/schema'
import { GRAPH_LOCK } from '../../../vector/hnsw/handles'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { loadNativeCore } from '../../../vector/native/loader'
import type { VectorIndex } from '../../../vector/vector-index'
import {
  binaryBuilt,
  builtIndex,
  clusteredVectors,
  DOCUMENTS,
  docIdOf,
  pointAtTheHostBinary,
  QUERIES,
  searchAll,
  settleBuild,
} from './fixtures'

const REMOVED_STEP = 5
const HELD_ALONE = -1
const BELOW_THE_PROMOTION_THRESHOLD = 40

function removeEveryFifth(index: VectorIndex): number {
  let removed = 0
  for (let position = 0; position < DOCUMENTS; position += REMOVED_STEP) {
    index.remove(docIdOf(position))
    removed += 1
  }
  return removed
}

describe.skipIf(!binaryBuilt)('graph writes through the native search core', () => {
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

  for (const quantization of ['none', 'osq4'] satisfies VectorQuantizationMode[]) {
    it(`removes and compacts to the same graph as the WebAssembly search for ${quantization}`, async () => {
      const core = loadNativeCore()
      expect(core).not.toBeNull()
      if (core === null) return
      const removals = vi.spyOn(core, 'remove')
      const compactions = vi.spyOn(core, 'compact')

      const throughWebAssembly = await builtIndex({ quantization, metric: 'cosine', native: false })
      removeEveryFifth(throughWebAssembly)
      throughWebAssembly.compact()
      expect(removals).toHaveBeenCalledTimes(0)
      expect(compactions).toHaveBeenCalledTimes(0)

      const throughNativeCore = await builtIndex({ quantization, metric: 'cosine', native: true })
      const removed = removeEveryFifth(throughNativeCore)
      throughNativeCore.compact()
      try {
        expect(removals.mock.results.filter(result => result.type === 'return' && result.value === 0)).toHaveLength(
          removed,
        )
        expect(compactions.mock.results.map(result => result.value)).toEqual([0])
        expect(throughNativeCore.size).toBe(DOCUMENTS - removed)
        expect(throughNativeCore.serialize()[0].graphs).toEqual(throughWebAssembly.serialize()[0].graphs)
        expect(searchAll(throughNativeCore, 'cosine', true)).toEqual(searchAll(throughWebAssembly, 'cosine', false))
      } finally {
        removals.mockRestore()
        compactions.mockRestore()
        throughWebAssembly.dispose()
        throughNativeCore.dispose()
      }
    })
  }

  it('leaves a removed document out of every search before the index compacts', async () => {
    const index = await builtIndex({ quantization: 'osq8', metric: 'euclidean', native: true })
    try {
      removeEveryFifth(index)
      const removedDocIds = new Set(
        Array.from({ length: DOCUMENTS / REMOVED_STEP }, (_, step) => docIdOf(step * REMOVED_STEP)),
      )
      for (const hits of searchAll(index, 'euclidean', true)) {
        expect(hits).toHaveLength(10)
        for (const [docId] of hits) expect(removedDocIds.has(String(docId))).toBe(false)
      }
    } finally {
      index.dispose()
    }
  })

  it('scans a field that holds no graph through score, with the same documents and scores', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const index = await builtIndex({
      quantization: 'none',
      metric: 'cosine',
      native: true,
      threshold: DOCUMENTS,
      documents: BELOW_THE_PROMOTION_THRESHOLD,
    })
    const scores = vi.spyOn(core, 'score')
    try {
      expect(index.maintenanceStatus().graphCount).toBe(0)
      const fromWebAssembly = searchAll(index, 'cosine', false)
      expect(scores).toHaveBeenCalledTimes(0)
      const fromNativeCore = searchAll(index, 'cosine', true)
      expect(scores).toHaveBeenCalledTimes(QUERIES)
      expect(fromNativeCore).toEqual(fromWebAssembly)
      expect(fromNativeCore.every(hits => hits.length === 10)).toBe(true)
    } finally {
      scores.mockRestore()
      index.dispose()
    }
  })

  it('scans the documents of a selective filter through score', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const index = await builtIndex({ quantization: 'osq4', metric: 'dotProduct', native: true })
    const scores = vi.spyOn(core, 'score')
    const searches = vi.spyOn(core, 'search')
    const allowed = new Set([docIdOf(3), docIdOf(77), docIdOf(410)])
    const [query] = clusteredVectors(1, 5)
    const options = { metric: 'dotProduct' as const, minSimilarity: Number.NEGATIVE_INFINITY, filterDocIds: allowed }
    try {
      const fromNativeCore = index.search(query, 3, options)
      expect(scores).toHaveBeenCalledTimes(1)
      expect(searches).toHaveBeenCalledTimes(0)
      setNativeSearchCoreEnabled(false)
      expect(fromNativeCore).toEqual(index.search(query, 3, options))
      expect(fromNativeCore.map(hit => hit.docId).sort()).toEqual([...allowed].sort())
    } finally {
      scores.mockRestore()
      searches.mockRestore()
      index.dispose()
    }
  })

  it('calibrates again when optimize rebuilds the graph, and leaves the centroid alone when it compacts', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const index = await builtIndex({ quantization: 'osq8', metric: 'euclidean', native: true })
    const calibrations = vi.spyOn(core, 'calibrate')
    try {
      const centroidBefore = index.serialize()[0].codes?.centroid
      for (let position = 0; position < DOCUMENTS; position += 2) index.remove(docIdOf(position))
      index.compact()
      expect(calibrations).toHaveBeenCalledTimes(0)
      expect(index.serialize()[0].codes?.centroid).toEqual(centroidBefore)

      for (let position = 1; position < DOCUMENTS / 2; position += 2) index.remove(docIdOf(position))
      await index.optimize()
      await settleBuild(index)
      expect(calibrations.mock.results.map(result => result.value)).toEqual([0])
      expect(index.serialize()[0].codes?.centroid).not.toEqual(centroidBefore)
      expect(searchAll(index, 'euclidean', true).every(hits => hits.length === 10)).toBe(true)
    } finally {
      calibrations.mockRestore()
      index.dispose()
    }
  })

  it('holds the graph alone while optimize writes the centroid and the codes again', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const attachments = vi.spyOn(core, 'attachGraph')
    const index = await builtIndex({ quantization: 'osq4', metric: 'cosine', native: true })
    const graphHeader = attachments.mock.calls[0]?.[0].graphHeader
    attachments.mockRestore()
    const graphLockAtEachWrite: number[] = []
    const calibrate = core.calibrate.bind(core)
    const quantise = core.quantise.bind(core)
    const calibrations = vi.spyOn(core, 'calibrate').mockImplementation((...args) => {
      graphLockAtEachWrite.push(graphHeader === undefined ? 0 : Atomics.load(graphHeader, GRAPH_LOCK))
      return calibrate(...args)
    })
    const firstRewrite = vi.spyOn(core, 'quantise').mockImplementationOnce((...args) => {
      graphLockAtEachWrite.push(graphHeader === undefined ? 0 : Atomics.load(graphHeader, GRAPH_LOCK))
      return quantise(...args)
    })
    try {
      for (let position = 0; position < DOCUMENTS; position += 2) index.remove(docIdOf(position))
      await index.optimize()
      await settleBuild(index)
      expect(graphLockAtEachWrite).toEqual([HELD_ALONE, HELD_ALONE])
    } finally {
      calibrations.mockRestore()
      firstRewrite.mockRestore()
      index.dispose()
    }
  })
})
