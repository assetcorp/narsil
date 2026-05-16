import { vi } from 'vitest'
import type { RuntimeInfo } from '../../../runtime/detect'
import type { HNSWConfig, SerializedHNSWGraph } from '../../../vector/hnsw'

export function createNodeRuntime(overrides?: Partial<RuntimeInfo>): RuntimeInfo {
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

export function createBrowserRuntime(overrides?: Partial<RuntimeInfo>): RuntimeInfo {
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

export function createNoWorkerRuntime(): RuntimeInfo {
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

export interface FakeWorker {
  worker: {
    postMessage: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
  }
  sendMessage(msg: unknown): void
}

export function createFakeNodeWorker(): FakeWorker {
  let messageHandler: ((msg: unknown) => void) | null = null
  return {
    worker: {
      postMessage: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'message') messageHandler = handler as (msg: unknown) => void
      }),
      terminate: vi.fn(),
    },
    sendMessage(msg: unknown) {
      messageHandler?.(msg)
    },
  }
}

export interface FakeWebWorker {
  worker: {
    postMessage: ReturnType<typeof vi.fn>
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
  }
  sendMessage(msg: unknown): void
}

export function createFakeWebWorker(): FakeWebWorker {
  let messageHandler: ((event: unknown) => void) | null = null
  return {
    worker: {
      postMessage: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'message') messageHandler = handler as (event: unknown) => void
      }),
      removeEventListener: vi.fn(),
      terminate: vi.fn(),
    },
    sendMessage(msg: unknown) {
      messageHandler?.({ data: msg })
    },
  }
}

export const sampleConfig: HNSWConfig = { m: 16, efConstruction: 200, metric: 'cosine' }

export const sampleGraph: SerializedHNSWGraph = {
  entryPoint: 'doc-1',
  maxLayer: 2,
  m: 16,
  efConstruction: 200,
  metric: 'cosine',
  nodes: [['doc-1', 0, [[0, ['doc-2']]]]],
}

export const testDocIds = ['doc-1']
export const testVectors = new Float32Array([1, 2, 3, 4])
export const testDim = 4

export function buildVectorData(count: number, dim: number): Float32Array {
  const data = new Float32Array(count * dim)
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random()
  }
  return data
}

export async function setupNodeWorkerMock(fakeWorker: FakeWorker): Promise<void> {
  const workerThreads = await import('node:worker_threads')
  const WorkerCtor = vi.mocked(workerThreads.Worker)
  WorkerCtor.mockImplementation(function workerCtor() {
    return fakeWorker.worker as unknown as InstanceType<typeof workerThreads.Worker>
  })
}

export function setupNodeWorkerAutoReply(fake: FakeWorker, reply: unknown): void {
  fake.worker.postMessage.mockImplementation(() => {
    queueMicrotask(() => fake.sendMessage(reply))
  })
}
