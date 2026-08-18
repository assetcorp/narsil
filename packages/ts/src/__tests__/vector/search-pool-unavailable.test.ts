import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnNodeWorker } from '#platform/node-worker'
import { detectRuntime, type RuntimeInfo } from '../../runtime/detect'
import { acquireVectorSearchPool, releaseVectorSearchPool } from '../../vector/search-pool'

vi.mock('../../runtime/detect', () => ({ detectRuntime: vi.fn() }))
vi.mock('#platform/node-worker', () => ({ spawnNodeWorker: vi.fn() }))

const NO_WORKER_RUNTIME: RuntimeInfo = {
  runtime: 'browser',
  supportsWorkerThreads: false,
  supportsWebWorkers: false,
  supportsFileSystem: false,
  supportsIndexedDB: true,
  supportsBroadcastChannel: true,
  cpuCount: 4,
}

beforeEach(() => {
  vi.mocked(detectRuntime).mockReturnValue(NO_WORKER_RUNTIME)
  vi.mocked(spawnNodeWorker).mockReset()
})

afterEach(() => {
  vi.mocked(detectRuntime).mockReset()
})

describe('a runtime that cannot spawn vector search workers', () => {
  it('tries once and then stops trying', async () => {
    expect(await acquireVectorSearchPool()).toBeNull()
    await releaseVectorSearchPool()

    const attemptsAfterFirst = vi.mocked(detectRuntime).mock.calls.length

    for (let attempt = 0; attempt < 20; attempt++) {
      expect(await acquireVectorSearchPool()).toBeNull()
      await releaseVectorSearchPool()
    }

    expect(vi.mocked(detectRuntime).mock.calls.length).toBe(attemptsAfterFirst)
  })

  it('keeps the holder count balanced so a later release is harmless', async () => {
    await acquireVectorSearchPool()
    await acquireVectorSearchPool()

    await expect(releaseVectorSearchPool()).resolves.toBeUndefined()
    await expect(releaseVectorSearchPool()).resolves.toBeUndefined()
    await expect(releaseVectorSearchPool()).resolves.toBeUndefined()
  })
})
