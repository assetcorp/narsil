import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { VectorQuantizationMode, VectorStorageMode } from '../../../types/schema'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import type { VectorIndex } from '../../../vector/vector-index'
import {
  binaryBuilt,
  builtIndex,
  clusteredVectors,
  DOCUMENTS,
  docIdOf,
  moveVectorsToAFile,
  pointAtTheHostBinary,
  searchAll,
  settleBuild,
} from './fixtures'

function refuseEveryFallback(operation: NativeOperation): void {
  throw new Error(`Narsil performed ${operation} in its own code while the native search core was loaded`)
}

async function performEveryOperation(index: VectorIndex, storage: VectorStorageMode, directory: string): Promise<void> {
  expect(searchAll(index, 'cosine', true).every(hits => hits.length === 10)).toBe(true)
  if (storage === 'disk') await moveVectorsToAFile(index, directory, 'generation-1')
  expect(searchAll(index, 'cosine', true).every(hits => hits.length === 10)).toBe(true)

  const allowed = new Set([docIdOf(1), docIdOf(2), docIdOf(3)])
  const [query] = clusteredVectors(1, 11)
  expect(index.search(query, 3, { metric: 'cosine', minSimilarity: -1, filterDocIds: allowed }).results).toHaveLength(3)

  for (let position = 0; position < DOCUMENTS; position += 3) index.remove(docIdOf(position))
  index.compact()
  clusteredVectors(80, 23).forEach((vector, position) => {
    index.insert(docIdOf(DOCUMENTS + position), vector)
  })
  await settleBuild(index)
  for (let position = 1; position < DOCUMENTS; position += 3) index.remove(docIdOf(position))
  await index.optimize()
  await settleBuild(index)
  expect(searchAll(index, 'cosine', true).every(hits => hits.length === 10)).toBe(true)
}

describe.skipIf(!binaryBuilt)('a process that loads the native search core', () => {
  let restorePath: () => void
  let directory: string

  beforeAll(async () => {
    restorePath = pointAtTheHostBinary()
    directory = await mkdtemp(join(tmpdir(), 'narsil-native-every-operation-'))
  })

  afterAll(async () => {
    restorePath()
    await rm(directory, { recursive: true, force: true })
  })

  afterEach(() => {
    observeFallbacks(null)
    setNativeSearchCoreEnabled(true)
  })

  for (const storage of ['memory', 'disk'] satisfies VectorStorageMode[]) {
    for (const quantization of ['none', 'osq4'] satisfies VectorQuantizationMode[]) {
      const vectorsAre = storage === 'disk' ? 'in a file' : 'in memory'
      it(`performs every vector operation through the core for ${quantization} with the vectors ${vectorsAre}`, async () => {
        observeFallbacks(refuseEveryFallback)
        const index = await builtIndex({ quantization, metric: 'cosine', native: true, storage })
        try {
          await performEveryOperation(index, storage, join(directory))
        } finally {
          index.dispose()
        }
      })
    }
  }

  it('reports the operation that Narsil performs in its own code once the core is off', async () => {
    const performed = new Set<NativeOperation>()
    observeFallbacks(operation => performed.add(operation))
    const index = await builtIndex({ quantization: 'osq4', metric: 'cosine', native: false })
    try {
      searchAll(index, 'cosine', false)
      index.remove(docIdOf(0))
      index.compact()
      expect([...performed].sort()).toEqual(['calibrate', 'compact', 'place', 'quantise', 'remove', 'score', 'search'])
    } finally {
      index.dispose()
    }
  })
})
