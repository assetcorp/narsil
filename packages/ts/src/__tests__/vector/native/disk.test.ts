import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import type { VectorQuantizationMode } from '../../../types/schema'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { loadNativeCore } from '../../../vector/native/loader'
import {
  binaryBuilt,
  builtIndex,
  clusteredVectors,
  DIMENSION,
  DOCUMENTS,
  docIdOf,
  METRICS,
  moveVectorsToAFile,
  pointAtTheHostBinary,
  QUERIES,
  searchAll,
  settleBuild,
} from './fixtures'

describe.skipIf(!binaryBuilt)('the native search core over a field kept on disk', () => {
  let restorePath: () => void
  let directory: string

  beforeAll(() => {
    restorePath = pointAtTheHostBinary()
  })

  afterAll(() => {
    restorePath()
  })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-native-disk-'))
  })

  afterEach(async () => {
    setNativeSearchCoreEnabled(true)
    await rm(directory, { recursive: true, force: true })
  })

  for (const quantization of ['none', 'osq4'] satisfies VectorQuantizationMode[]) {
    for (const metric of METRICS) {
      it(`searches vectors in a file with the same documents and scores for ${quantization} under ${metric}`, async () => {
        const core = loadNativeCore()
        expect(core).not.toBeNull()
        if (core === null) return
        const index = await builtIndex({ quantization, metric, native: true, storage: 'disk' })
        try {
          const inMemory = searchAll(index, metric, true)
          await moveVectorsToAFile(index, directory, 'generation-1')
          const searches = vi.spyOn(core, 'search')
          const scores = vi.spyOn(core, 'score')
          const fromNativeCore = searchAll(index, metric, true)
          expect(searches).toHaveBeenCalledTimes(QUERIES)
          expect(scores).toHaveBeenCalledTimes(quantization === 'none' ? 0 : QUERIES)
          searches.mockRestore()
          scores.mockRestore()
          expect(fromNativeCore).toEqual(inMemory)
          expect(fromNativeCore).toEqual(searchAll(index, metric, false))
        } finally {
          index.dispose()
        }
      })
    }
  }

  it('places a vector beside neighbours whose vectors a file holds, as the WebAssembly search places it', async () => {
    const graphs: unknown[] = []
    for (const native of [false, true]) {
      const index = await builtIndex({ quantization: 'none', metric: 'cosine', native, storage: 'disk' })
      try {
        await moveVectorsToAFile(index, directory, `placement-${native}`)
        setNativeSearchCoreEnabled(native)
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const later = clusteredVectors(DOCUMENTS + 60, 7).slice(DOCUMENTS)
        later.forEach((vector, position) => {
          index.insert(docIdOf(DOCUMENTS + position), vector)
        })
        await settleBuild(index)
        random.mockRestore()
        graphs.push(index.serialize()[0].graphs)
      } finally {
        index.dispose()
      }
    }
    expect(graphs[1]).toEqual(graphs[0])
  })

  it('lets go of every vector file before the engine deletes a dropped index', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await engine.createIndex('papers', {
      schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
      language: 'english',
      vectorPromotion: { threshold: 8, quantization: 'osq8' },
    })
    const vectors = clusteredVectors(40, 3)
    for (let position = 0; position < vectors.length; position++) {
      await engine.insert('papers', { title: `Paper ${position}`, embedding: Array.from(vectors[position]) })
    }
    await engine.checkpoint('papers')
    const searches = vi.spyOn(core, 'search')
    const found = await engine.query('papers', { vector: { field: 'embedding', value: Array.from(vectors[4]) } })
    expect(found.hits.length).toBeGreaterThan(0)
    expect(searches).toHaveBeenCalled()
    searches.mockRestore()

    const durable = createDurableDirectory(directory)
    const [vectorFileKey] = (await durable.list('papers/segments/')).filter(key => key.includes('/vec-embedding-'))
    const vectorFile = await durable.pathOf(vectorFileKey)
    const fileStoodAtEachDetachment: boolean[] = []
    const detachStore = core.detachStore.bind(core)
    const detachments = vi.spyOn(core, 'detachStore').mockImplementation(store => {
      fileStoodAtEachDetachment.push(existsSync(vectorFile))
      return detachStore(store)
    })
    await engine.dropIndex('papers')
    detachments.mockRestore()
    expect(fileStoodAtEachDetachment[0]).toBe(true)
    expect(await durable.list('papers/')).toEqual([])
    await engine.shutdown()
  })

  it('searches in its own code while the core cannot map a vector file', async () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const index = await builtIndex({ quantization: 'osq8', metric: 'cosine', native: true, storage: 'disk' })
    try {
      const path = await moveVectorsToAFile(index, directory, 'generation-1')
      await index.releaseVectorFiles()
      await rm(path)
      const attachments = vi.spyOn(core, 'attachStore')
      const searches = vi.spyOn(core, 'search')
      expect(() => searchAll(index, 'cosine', true)).not.toThrow()
      expect(attachments.mock.results.map(result => result.type)).toEqual(['throw'])
      expect(searches).toHaveBeenCalledTimes(0)
      attachments.mockRestore()
      searches.mockRestore()
    } finally {
      index.dispose()
    }
  })

  it('lets go of a vector file once the field reads every vector from a newer file', async () => {
    const index = await builtIndex({ quantization: 'osq8', metric: 'cosine', native: true, storage: 'disk' })
    try {
      const core = loadNativeCore()
      expect(core).not.toBeNull()
      if (core === null) return
      const first = await moveVectorsToAFile(index, directory, 'generation-1')
      const beforeTheMove = searchAll(index, 'cosine', true)
      const second = await moveVectorsToAFile(index, directory, 'generation-2')
      const attachments = vi.spyOn(core, 'attachStore')
      const afterTheMove = searchAll(index, 'cosine', true)
      const mappedFiles = attachments.mock.calls.map(([memory]) => memory.vectorFiles)
      attachments.mockRestore()
      expect(mappedFiles).toEqual([['', second]])
      await rm(first)
      expect(existsSync(first)).toBe(false)
      expect(afterTheMove).toEqual(beforeTheMove)
      expect(searchAll(index, 'cosine', true)).toEqual(beforeTheMove)
    } finally {
      index.dispose()
    }
  })
})
