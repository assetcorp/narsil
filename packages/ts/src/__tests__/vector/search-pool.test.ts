import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnNodeWorker } from '#platform/node-worker'
import { detectRuntime, type RuntimeInfo } from '../../runtime/detect'
import { acquireVectorSearchPool, createVectorSearchPool, releaseVectorSearchPool } from '../../vector/search-pool'
import type { WorkerCopySnapshot } from '../../vector/worker-copy'

vi.mock('../../runtime/detect', () => ({ detectRuntime: vi.fn() }))
vi.mock('#platform/node-worker', () => ({ spawnNodeWorker: vi.fn() }))

const BROWSER_RUNTIME: RuntimeInfo = {
  runtime: 'browser',
  supportsWorkerThreads: false,
  supportsWebWorkers: true,
  supportsFileSystem: false,
  supportsIndexedDB: true,
  supportsBroadcastChannel: true,
  cpuCount: 4,
}

const NODE_RUNTIME: RuntimeInfo = { ...BROWSER_RUNTIME, runtime: 'node', supportsWorkerThreads: true }

const NO_WORKER_RUNTIME: RuntimeInfo = { ...BROWSER_RUNTIME, supportsWebWorkers: false }

type Reply = (message: Record<string, unknown>) => Record<string, unknown> | null

class FakeWebWorker {
  static instances: FakeWebWorker[] = []
  static reply: Reply = () => null

  readonly url: string | URL
  readonly options: { type?: string } | undefined
  readonly received: Record<string, unknown>[] = []
  terminated = false

  private readonly listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor(url: string | URL, options?: { type?: string }) {
    this.url = url
    this.options = options
    FakeWebWorker.instances.push(this)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type)
    if (existing) existing.push(handler)
    else this.listeners.set(type, [handler])
  }

  postMessage(message: Record<string, unknown>): void {
    this.received.push(message)
    const reply = FakeWebWorker.reply(message)
    if (reply === null) return
    queueMicrotask(() => {
      this.emit('message', { data: reply })
    })
  }

  terminate(): void {
    this.terminated = true
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

const SNAPSHOT = { dimension: 2, quantization: 'none', tombstones: [] } as unknown as WorkerCopySnapshot

function ackEverything(message: Record<string, unknown>): Record<string, unknown> | null {
  if (message.type === 'load' || message.type === 'drop') {
    return { type: 'ack', requestId: message.requestId, handle: message.handle }
  }
  if (message.type === 'search') {
    return { type: 'result', requestId: message.requestId, docIds: ['a', 'b'], scores: [0.9, 0.5] }
  }
  return null
}

beforeEach(() => {
  FakeWebWorker.instances = []
  FakeWebWorker.reply = ackEverything
  ;(globalThis as Record<string, unknown>).Worker = FakeWebWorker
  vi.mocked(detectRuntime).mockReturnValue(BROWSER_RUNTIME)
  vi.mocked(spawnNodeWorker).mockReset()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Worker
})

describe('the Web Worker spawn branch', () => {
  it('constructs one module worker per slot from the built worker entry point', async () => {
    const pool = await createVectorSearchPool(3)

    expect(pool?.workerCount).toBe(3)
    expect(FakeWebWorker.instances).toHaveLength(3)
    for (const worker of FakeWebWorker.instances) {
      expect(worker.options?.type).toBe('module')
      expect(String(worker.url)).toMatch(/\/dist\/vector\/search-worker\.mjs$/)
    }
    expect(vi.mocked(spawnNodeWorker)).not.toHaveBeenCalled()
    await pool?.shutdown()
  })

  it('reads replies from the event data rather than the event itself', async () => {
    const pool = await createVectorSearchPool(1)

    const results = await pool?.search('embedding#1', new Float32Array([1, 0]), 2, 'cosine', 0)

    expect(results).toEqual([
      { docId: 'a', score: 0.9 },
      { docId: 'b', score: 0.5 },
    ])
    await pool?.shutdown()
  })

  it('loads a copy into every worker before reporting success', async () => {
    const pool = await createVectorSearchPool(2)

    await expect(pool?.load('embedding#1', SNAPSHOT)).resolves.toBe(true)
    for (const worker of FakeWebWorker.instances) {
      expect(worker.received[0]).toMatchObject({ type: 'load', handle: 'embedding#1' })
    }
    await pool?.shutdown()
  })

  it('reports a failed load when one worker refuses the copy', async () => {
    const pool = await createVectorSearchPool(2)
    FakeWebWorker.reply = message =>
      FakeWebWorker.instances[1].received.includes(message)
        ? { type: 'error', requestId: message.requestId, message: 'out of memory' }
        : ackEverything(message)

    await expect(pool?.load('embedding#1', SNAPSHOT)).resolves.toBe(false)
    await pool?.shutdown()
  })

  it('fails the queries in flight when a worker reports an error', async () => {
    const pool = await createVectorSearchPool(1)
    FakeWebWorker.reply = () => null
    const search = pool?.search('embedding#1', new Float32Array([1, 0]), 2, 'cosine', 0)

    FakeWebWorker.instances[0].emit('error', {})

    await expect(search).rejects.toThrow(/Vector search worker failed/)
    expect(pool?.workerCount).toBe(0)
    await pool?.shutdown()
  })

  it('takes no pool when the runtime names Web Workers but supplies no constructor', async () => {
    delete (globalThis as Record<string, unknown>).Worker

    await expect(createVectorSearchPool(2)).resolves.toBeNull()
  })

  it('takes no pool when the runtime supports neither kind of worker', async () => {
    vi.mocked(detectRuntime).mockReturnValue(NO_WORKER_RUNTIME)

    await expect(createVectorSearchPool(2)).resolves.toBeNull()
    expect(FakeWebWorker.instances).toHaveLength(0)
  })
})

describe('the no-worker fallback', () => {
  it('takes no pool when spawning a Node worker throws', async () => {
    vi.mocked(detectRuntime).mockReturnValue(NODE_RUNTIME)
    vi.mocked(spawnNodeWorker).mockRejectedValue(new Error('worker_threads is unavailable'))

    await expect(createVectorSearchPool(4)).resolves.toBeNull()
    expect(FakeWebWorker.instances).toHaveLength(0)
  })

  it('refuses a search once every worker has failed', async () => {
    const pool = await createVectorSearchPool(1)
    FakeWebWorker.instances[0].emit('error', {})

    await expect(pool?.search('embedding#1', new Float32Array([1, 0]), 1, 'cosine', 0)).rejects.toThrow(
      /No vector search worker is running/,
    )
    await pool?.shutdown()
  })
})

describe('two indexes sharing one pool', () => {
  it('builds the pool once and holds it until the last index lets go', async () => {
    const first = await acquireVectorSearchPool()
    const second = await acquireVectorSearchPool()

    expect(first).toBe(second)
    const spawned = FakeWebWorker.instances.length
    expect(spawned).toBeGreaterThan(0)

    await releaseVectorSearchPool()

    expect(FakeWebWorker.instances.every(worker => !worker.terminated)).toBe(true)
    expect(await acquireVectorSearchPool()).toBe(first)
    expect(FakeWebWorker.instances).toHaveLength(spawned)

    await releaseVectorSearchPool()
    await releaseVectorSearchPool()

    expect(FakeWebWorker.instances.every(worker => worker.terminated)).toBe(true)
  })

  it('answers each index under its own handle', async () => {
    const pool = await acquireVectorSearchPool()
    FakeWebWorker.reply = message =>
      message.type === 'search'
        ? { type: 'result', requestId: message.requestId, docIds: [`${message.handle}-hit`], scores: [1] }
        : ackEverything(message)

    const title = await pool?.search('title#1', new Float32Array([1, 0]), 1, 'cosine', 0)
    const body = await pool?.search('body#2', new Float32Array([1, 0]), 1, 'cosine', 0)

    expect(title?.[0].docId).toBe('title#1-hit')
    expect(body?.[0].docId).toBe('body#2-hit')

    await releaseVectorSearchPool()
  })

  it('builds a fresh pool for the next index after the last one lets go', async () => {
    const first = await acquireVectorSearchPool()
    await releaseVectorSearchPool()
    const spawned = FakeWebWorker.instances.length

    const second = await acquireVectorSearchPool()

    expect(second).not.toBe(first)
    expect(FakeWebWorker.instances).toHaveLength(spawned * 2)
    await releaseVectorSearchPool()
  })

  it('ignores a release from a holder that never acquired', async () => {
    await expect(releaseVectorSearchPool()).resolves.toBeUndefined()
    expect(FakeWebWorker.instances).toHaveLength(0)
  })
})
