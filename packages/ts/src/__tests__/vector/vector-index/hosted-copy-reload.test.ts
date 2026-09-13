import { afterEach, describe, expect, it } from 'vitest'
import type { GraphInsertOutcome } from '../../../vector/shared-field/types'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import type { SharedCopyHost } from '../../../vector/vector-index/shared'
import { createFakeVectorThreads, DIM, normalizedVector } from './fixtures'

const HOST_THREAD_SLOT = 1
const DOC_COUNT = 16

interface FakeHost {
  host: SharedCopyHost
  loads: string[]
  drops: string[]
  placed: number[]
}

function createFakeHost(): FakeHost {
  const threads = createFakeVectorThreads(HOST_THREAD_SLOT)
  const loads: string[] = []
  const drops: string[] = []
  const placed: number[] = []

  const host: SharedCopyHost = {
    workerCount: 2,
    holdsIndex: () => true,
    resolvePartition: () => 0,

    async loadShared(_indexName, _fieldName, handle, handles): Promise<boolean> {
      loads.push(handle)
      return threads.open(handle, handles)
    },

    async drop(_indexName, _fieldName, handle): Promise<void> {
      drops.push(handle)
      threads.drop(handle)
    },

    async insertOrdinals(_indexName, _fieldName, handle, ordinals): Promise<GraphInsertOutcome | null> {
      for (const ordinal of ordinals) placed.push(ordinal)
      return threads.insertOrdinals(handle, ordinals)
    },
  }

  return { host, loads, drops, placed }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function insertAndBuild(index: VectorIndex, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
  }
  index.scheduleBuild()
  await settle()
  await index.awaitPendingBuild()
  await settle()
}

describe('a vector field the request threads hold', () => {
  let index: VectorIndex

  afterEach(() => {
    index.dispose()
  })

  function hostedIndex(host: SharedCopyHost): VectorIndex {
    return createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: true, host }, 'shop')
  }

  it('places every vector through the threads that hold the field', async () => {
    const { host, drops, placed } = createFakeHost()
    index = hostedIndex(host)
    await insertAndBuild(index, DOC_COUNT)

    expect(placed).toHaveLength(DOC_COUNT)
    expect(drops).toEqual([])
    expect(index.search(normalizedVector(DIM, 4), 5, { metric: 'cosine', minSimilarity: 0 })).toHaveLength(5)
  })

  it('sends the field again under a fresh handle after a refresh', async () => {
    const { host, loads, drops } = createFakeHost()
    index = hostedIndex(host)
    await insertAndBuild(index, DOC_COUNT)
    const held = new Set(loads)

    index.refreshWorkerCopies()
    await settle()

    expect(new Set(drops)).toEqual(held)
    expect(held.has(loads[loads.length - 1])).toBe(false)
  })
})
