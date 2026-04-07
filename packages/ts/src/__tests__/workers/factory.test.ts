import { describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import type { RuntimeInfo } from '../../runtime/detect'

vi.mock('../../runtime/detect', () => ({
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

vi.mock('../../workers/worker-executor', () => ({
  createWorkerExecutor: vi.fn(() => ({
    async execute<T>(): Promise<T> {
      return undefined as T
    },
    async shutdown(): Promise<void> {},
  })),
}))

import { detectRuntime } from '../../runtime/detect'
import { createWorkerFactory } from '../../workers/factory'
import { createWorkerExecutor } from '../../workers/worker-executor'

const mockedDetectRuntime = vi.mocked(detectRuntime)
const mockedCreateWorkerExecutor = vi.mocked(createWorkerExecutor)

function createNodeRuntime(overrides?: Partial<RuntimeInfo>): RuntimeInfo {
  return {
    runtime: 'node',
    supportsWorkerThreads: true,
    supportsWebWorkers: false,
    supportsFileSystem: true,
    supportsIndexedDB: false,
    supportsBroadcastChannel: false,
    cpuCount: 4,
    ...overrides,
  }
}

function createBrowserRuntime(overrides?: Partial<RuntimeInfo>): RuntimeInfo {
  return {
    runtime: 'browser',
    supportsWorkerThreads: false,
    supportsWebWorkers: true,
    supportsFileSystem: false,
    supportsIndexedDB: true,
    supportsBroadcastChannel: true,
    cpuCount: 4,
    ...overrides,
  }
}

function createNoWorkerRuntime(): RuntimeInfo {
  return {
    runtime: 'browser',
    supportsWorkerThreads: false,
    supportsWebWorkers: false,
    supportsFileSystem: false,
    supportsIndexedDB: false,
    supportsBroadcastChannel: false,
    cpuCount: 1,
  }
}

describe('createWorkerFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Node.js worker threads path', () => {
    it('returns a factory function when supportsWorkerThreads is true', async () => {
      mockedDetectRuntime.mockReturnValue(createNodeRuntime())

      const factory = await createWorkerFactory()
      expect(typeof factory).toBe('function')
    })

    it('creates an executor using node:worker_threads Worker on each factory call', async () => {
      mockedDetectRuntime.mockReturnValue(createNodeRuntime())

      const workerThreads = await import('node:worker_threads')
      const WorkerCtor = vi.mocked(workerThreads.Worker)

      const factory = await createWorkerFactory()
      factory(0)

      expect(WorkerCtor).toHaveBeenCalledOnce()
      expect(mockedCreateWorkerExecutor).toHaveBeenCalledOnce()
    })

    it('creates a new Worker instance for each factory call', async () => {
      mockedDetectRuntime.mockReturnValue(createNodeRuntime())

      const workerThreads = await import('node:worker_threads')
      const WorkerCtor = vi.mocked(workerThreads.Worker)

      const factory = await createWorkerFactory()
      factory(0)
      factory(1)
      factory(2)

      expect(WorkerCtor).toHaveBeenCalledTimes(3)
      expect(mockedCreateWorkerExecutor).toHaveBeenCalledTimes(3)
    })
  })

  describe('Web Worker path', () => {
    it('returns a factory when supportsWebWorkers is true', async () => {
      mockedDetectRuntime.mockReturnValue(createBrowserRuntime())

      const fakeWebWorker = { postMessage: vi.fn(), addEventListener: vi.fn() }
      const originalWorker = (globalThis as Record<string, unknown>).Worker
      ;(globalThis as Record<string, unknown>).Worker = vi.fn(function webWorkerCtor() {
        return fakeWebWorker
      })

      try {
        const factory = await createWorkerFactory()
        expect(typeof factory).toBe('function')

        factory(0)
        expect(mockedCreateWorkerExecutor).toHaveBeenCalledOnce()
      } finally {
        if (originalWorker !== undefined) {
          ;(globalThis as Record<string, unknown>).Worker = originalWorker
        } else {
          delete (globalThis as Record<string, unknown>).Worker
        }
      }
    })
  })

  describe('no worker support', () => {
    it('throws NarsilError with WORKER_CRASHED code when no workers available', async () => {
      mockedDetectRuntime.mockReturnValue(createNoWorkerRuntime())

      await expect(createWorkerFactory()).rejects.toThrow(NarsilError)

      try {
        await createWorkerFactory()
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.WORKER_CRASHED)
      }
    })
  })

  describe('custom entryPoint', () => {
    it('uses the provided entryPoint instead of resolving from import.meta.url', async () => {
      mockedDetectRuntime.mockReturnValue(createNodeRuntime())

      const workerThreads = await import('node:worker_threads')
      const WorkerCtor = vi.mocked(workerThreads.Worker)

      const customEntry = 'file:///custom/path/to/worker.mjs'
      const factory = await createWorkerFactory(customEntry)
      factory(0)

      const constructorCall = WorkerCtor.mock.calls[0]
      expect(constructorCall).toBeDefined()
      const urlArg = constructorCall[0]
      expect(urlArg).toBeInstanceOf(URL)
      expect((urlArg as URL).href).toBe(customEntry)
    })
  })

  describe('factory reuse', () => {
    it('can be called multiple times with each call producing independent executors', async () => {
      mockedDetectRuntime.mockReturnValue(createNodeRuntime())

      let callCount = 0
      mockedCreateWorkerExecutor.mockImplementation(() => {
        callCount++
        return {
          async execute<T>(): Promise<T> {
            return callCount as T
          },
          async shutdown(): Promise<void> {},
        }
      })

      const factory = await createWorkerFactory()
      const executor1 = factory(0)
      const executor2 = factory(1)

      expect(executor1).not.toBe(executor2)
    })
  })
})
