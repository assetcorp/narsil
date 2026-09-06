import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import type { SharedCopyHost } from '../../../vector/vector-index/shared'
import { DIM, normalizedVector } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

interface PendingLoad {
  handle: string
  resolve: (loaded: boolean) => void
}

interface FakeHost {
  host: SharedCopyHost
  loads: PendingLoad[]
  drops: string[]
}

function createFakeHost(): FakeHost {
  const loads: PendingLoad[] = []
  const drops: string[] = []
  const host: SharedCopyHost = {
    scratchSlotCount: 1,
    holdsIndex: () => true,
    resolvePartition: () => 0,
    loadShared: (_indexName, _fieldName, handle) =>
      new Promise<boolean>(resolve => {
        loads.push({ handle, resolve })
      }),
    async drop(_indexName, _fieldName, handle) {
      drops.push(handle)
    },
  }
  return { host, loads, drops }
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

describe('a hosted vector copy whose load a refresh overtakes', () => {
  let index: VectorIndex

  afterEach(() => {
    index.dispose()
  })

  it('loads the copy again under a new handle once the overtaken load settles', async () => {
    const { host, loads, drops } = createFakeHost()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: true, host }, 'shop')
    await insertAndBuild(index, 16)
    expect(loads).toHaveLength(1)

    index.refreshWorkerCopies()
    await settle()
    expect(drops).toEqual([loads[0].handle])
    expect(loads).toHaveLength(1)

    loads[0].resolve(true)
    await settle()

    expect(loads).toHaveLength(2)
    expect(loads[1].handle).not.toBe(loads[0].handle)
    loads[1].resolve(true)
    await settle()
    expect(drops).toEqual([loads[0].handle])
  })

  it('stays quiet after a load that nothing overtook', async () => {
    const { host, loads, drops } = createFakeHost()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: true, host }, 'shop')
    await insertAndBuild(index, 16)

    loads[0].resolve(true)
    await settle()

    expect(loads).toHaveLength(1)
    expect(drops).toEqual([])
  })
})
