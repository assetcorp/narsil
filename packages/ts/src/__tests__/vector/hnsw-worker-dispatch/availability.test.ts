import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeInfo } from '../../../runtime/detect'

vi.mock('../../../runtime/detect', () => ({
  detectRuntime: vi.fn<() => RuntimeInfo>(() => ({
    runtime: 'node',
    supportsWorkerThreads: false,
    supportsWebWorkers: false,
    supportsFileSystem: true,
    supportsIndexedDB: false,
    supportsBroadcastChannel: false,
    cpuCount: 4,
  })),
}))

vi.mock('node:worker_threads', () => {
  const WorkerMock = vi.fn()
  return { Worker: WorkerMock }
})

import { detectRuntime } from '../../../runtime/detect'
import {
  dispatchWorkerBuild,
  probeWorkerAvailability,
  resetWorkerAvailabilityCache,
} from '../../../vector/hnsw-worker-dispatch'
import {
  createBrowserRuntime,
  createFakeWebWorker,
  createNodeRuntime,
  createNoWorkerRuntime,
  sampleConfig,
  sampleGraph,
  testDim,
  testDocIds,
  testVectors,
} from './fixtures'

const mockedDetectRuntime = vi.mocked(detectRuntime)

describe('listenForMessage with WebWorker interface', () => {
  beforeEach(() => {
    resetWorkerAvailabilityCache()
    vi.clearAllMocks()
  })

  it('handles messages via addEventListener for web workers', async () => {
    mockedDetectRuntime.mockReturnValue(createBrowserRuntime())

    const fake = createFakeWebWorker()

    const originalWorker = (globalThis as Record<string, unknown>).Worker
    ;(globalThis as Record<string, unknown>).Worker = vi.fn(function webWorkerCtor() {
      return fake.worker as unknown
    }) as unknown

    try {
      fake.worker.postMessage.mockImplementation(() => {
        queueMicrotask(() => fake.sendMessage({ type: 'success', graph: sampleGraph }))
      })

      const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

      expect(result).toEqual({ ok: true, graph: sampleGraph })
      expect(fake.worker.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    } finally {
      if (originalWorker !== undefined) {
        ;(globalThis as Record<string, unknown>).Worker = originalWorker
      } else {
        delete (globalThis as Record<string, unknown>).Worker
      }
    }
  })

  it('handles error messages via addEventListener for web workers', async () => {
    mockedDetectRuntime.mockReturnValue(createBrowserRuntime())

    const fake = createFakeWebWorker()

    const originalWorker = (globalThis as Record<string, unknown>).Worker
    ;(globalThis as Record<string, unknown>).Worker = vi.fn(function webWorkerCtor() {
      return fake.worker as unknown
    }) as unknown

    try {
      fake.worker.postMessage.mockImplementation(() => {
        queueMicrotask(() => fake.sendMessage({ type: 'error', message: 'web worker error' }))
      })

      const result = await dispatchWorkerBuild(testDocIds, testVectors, testDim, sampleConfig)

      expect(result).toEqual({
        ok: false,
        reason: 'build-error',
        message: 'web worker error',
      })
    } finally {
      if (originalWorker !== undefined) {
        ;(globalThis as Record<string, unknown>).Worker = originalWorker
      } else {
        delete (globalThis as Record<string, unknown>).Worker
      }
    }
  })
})

describe('probeWorkerAvailability', () => {
  beforeEach(() => {
    resetWorkerAvailabilityCache()
    vi.clearAllMocks()
  })

  it('returns true when supportsWorkerThreads is true', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    const result = await probeWorkerAvailability()
    expect(result).toBe(true)
  })

  it('returns true when supportsWebWorkers is true', async () => {
    mockedDetectRuntime.mockReturnValue(createBrowserRuntime())

    const result = await probeWorkerAvailability()
    expect(result).toBe(true)
  })

  it('returns false when neither worker type is supported', async () => {
    mockedDetectRuntime.mockReturnValue(createNoWorkerRuntime())

    const result = await probeWorkerAvailability()
    expect(result).toBe(false)
  })

  it('caches result and does not call detectRuntime on subsequent calls', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())

    await probeWorkerAvailability()
    const callCountAfterFirst = mockedDetectRuntime.mock.calls.length

    await probeWorkerAvailability()
    expect(mockedDetectRuntime.mock.calls.length).toBe(callCountAfterFirst)
  })
})

describe('resetWorkerAvailabilityCache', () => {
  beforeEach(() => {
    resetWorkerAvailabilityCache()
    vi.clearAllMocks()
  })

  it('forces probeWorkerAvailability to re-check runtime after reset', async () => {
    mockedDetectRuntime.mockReturnValue(createNodeRuntime())
    await probeWorkerAvailability()

    resetWorkerAvailabilityCache()
    mockedDetectRuntime.mockReturnValue(createNoWorkerRuntime())

    const result = await probeWorkerAvailability()
    expect(result).toBe(false)
  })
})
