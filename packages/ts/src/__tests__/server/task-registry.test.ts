import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { InMemoryTaskStore } from '../../server'
import { TaskRegistry } from '../../server/tasks'
import type { TaskRecord, TaskStore } from '../../server/types'

function createRegistry(store: TaskStore = new InMemoryTaskStore(), instanceId = 'test-instance'): TaskRegistry {
  return new TaskRegistry(store, instanceId)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolveInner, rejectInner) => {
    resolve = resolveInner
    reject = rejectInner
  })
  return { promise, resolve, reject }
}

async function settledRecord(registry: TaskRegistry, id: string): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await registry.get(id)
    if (record && record.status !== 'running' && record.status !== 'queued') return record
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('The task never reached a terminal status')
}

describe('TaskRegistry cancellation', () => {
  it('marks a task cancelled when the work stops on the signal', async () => {
    const registry = createRegistry()
    const started = deferred<void>()

    const record = await registry.start('import', 'movies', async context => {
      started.resolve()
      await new Promise<void>((_, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
      })
    })
    await started.promise

    const cancelled = await registry.cancel(record.id)
    expect(cancelled.outcome).toBe('cancelling')
    expect(cancelled.record?.cancelRequestedAt).toBeGreaterThan(0)

    const settled = await settledRecord(registry, record.id)
    expect(settled.status).toBe('cancelled')
    expect(settled.error).toBeUndefined()
    expect(settled.completedAt).toBeGreaterThanOrEqual(settled.createdAt)
  })

  it('leaves a task succeeded when the work finished before it noticed the cancel', async () => {
    const registry = createRegistry()
    const started = deferred<void>()
    const finish = deferred<void>()

    const record = await registry.start('import', 'movies', async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise

    expect((await registry.cancel(record.id)).outcome).toBe('cancelling')
    finish.resolve()

    const settled = await settledRecord(registry, record.id)
    expect(settled.status).toBe('succeeded')
  })

  it('reports a task another instance owns as uncancellable here', async () => {
    const store = new InMemoryTaskStore()
    const owner = createRegistry(store, 'instance-one')
    const started = deferred<void>()
    const finish = deferred<void>()
    const record = await owner.start('rebalance', 'movies', async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise

    const stranger = createRegistry(store, 'instance-two')
    const attempted = await stranger.cancel(record.id)

    expect(attempted.outcome).toBe('owned-by-another-instance')
    expect(attempted.record?.owner).toBe('instance-one')
    finish.resolve()
    await settledRecord(owner, record.id)
  })

  it('reports an unknown task rather than inventing one', async () => {
    const registry = createRegistry()
    expect((await registry.cancel('nothing-here')).outcome).toBe('not-found')
  })
})

describe('TaskRegistry results and failures', () => {
  it('carries the reported result onto the finished record', async () => {
    const registry = createRegistry()
    const record = await registry.start('import', 'movies', async context => {
      context.reportResult({ indexed: 7, failed: 1, errors: [], errorsTruncated: true })
    })

    const settled = await settledRecord(registry, record.id)
    expect(settled.status).toBe('succeeded')
    expect(settled.result).toEqual({ indexed: 7, failed: 1, errors: [], errorsTruncated: true })
  })

  it('records the engine code behind a failure', async () => {
    const registry = createRegistry()
    const record = await registry.start('rebalance', 'movies', async () => {
      throw new NarsilError('PARTITION_CAPACITY_EXCEEDED', 'Too many documents')
    })

    const settled = await settledRecord(registry, record.id)
    expect(settled.status).toBe('failed')
    expect(settled.error?.code).toBe('PARTITION_CAPACITY_EXCEEDED')
  })

  it('hides an unexpected failure behind a generic message', async () => {
    const registry = createRegistry()
    const record = await registry.start('restore', 'movies', async () => {
      throw new Error('/private/path/leaked.nrsl')
    })

    const settled = await settledRecord(registry, record.id)
    expect(settled.error?.code).toBe('INTERNAL_ERROR')
    expect(settled.error?.message).not.toContain('leaked')
  })

  it('keeps the last progress it was given', async () => {
    const registry = createRegistry()
    const record = await registry.start(
      'import',
      'movies',
      async context => {
        context.reportProgress({ indexed: 10, failed: 0, bytesProcessed: 50, bytesTotal: 100 })
        context.reportProgress({ indexed: 20, failed: 0, bytesProcessed: 100, bytesTotal: 100 })
      },
      { indexed: 0, failed: 0, bytesProcessed: 0, bytesTotal: 100 },
    )

    const settled = await settledRecord(registry, record.id)
    expect(settled.progress).toEqual({ indexed: 20, failed: 0, bytesProcessed: 100, bytesTotal: 100 })
  })
})

describe('TaskRegistry listing', () => {
  async function seedRegistry(): Promise<TaskRegistry> {
    const registry = createRegistry()
    const records = [
      { type: 'import' as const, indexName: 'movies' },
      { type: 'rebalance' as const, indexName: 'books' },
      { type: 'import' as const, indexName: 'books' },
    ]
    for (const entry of records) {
      const record = await registry.start(entry.type, entry.indexName, async () => {})
      await settledRecord(registry, record.id)
    }
    return registry
  }

  it('orders the newest task first', async () => {
    const page = await (await seedRegistry()).list()
    const timestamps = page.tasks.map(task => task.createdAt)
    expect([...timestamps].sort((left, right) => right - left)).toEqual(timestamps)
    expect(page.total).toBe(3)
    expect(page.next).toBeNull()
  })

  it('narrows by index, type, and status together', async () => {
    const registry = await seedRegistry()
    const page = await registry.list({ indexName: 'books', type: ['import'], status: ['succeeded'] })

    expect(page.total).toBe(1)
    expect(page.tasks[0].indexName).toBe('books')
    expect(page.tasks[0].type).toBe('import')
  })

  it('walks every match exactly once across pages', async () => {
    const registry = await seedRegistry()
    const seen: string[] = []
    let from: number | null = 0
    while (from !== null) {
      const page = await registry.list({ from, limit: 2 })
      for (const task of page.tasks) seen.push(task.id)
      from = page.next
    }

    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
  })

  it('reports an empty page past the end rather than failing', async () => {
    const page = await (await seedRegistry()).list({ from: 99 })
    expect(page.tasks).toEqual([])
    expect(page.next).toBeNull()
    expect(page.total).toBe(3)
  })
})

describe('TaskRegistry restart recovery', () => {
  it('fails the tasks it owned before the restart', async () => {
    const store = new InMemoryTaskStore()
    const beforeRestart = createRegistry(store, 'stable-instance')
    const finish = deferred<void>()
    const started = deferred<void>()
    const record = await beforeRestart.start('import', 'movies', async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise

    const afterRestart = createRegistry(store, 'stable-instance')
    await afterRestart.reconcile()

    const recovered = await afterRestart.get(record.id)
    expect(recovered?.status).toBe('failed')
    expect(recovered?.error?.code).toBe('TASK_INTERRUPTED')
    finish.resolve()
  })

  it('leaves the running tasks of another instance alone', async () => {
    const store = new InMemoryTaskStore()
    const owner = createRegistry(store, 'instance-one')
    const finish = deferred<void>()
    const started = deferred<void>()
    const record = await owner.start('import', 'movies', async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise

    await createRegistry(store, 'instance-two').reconcile()

    expect((await owner.get(record.id))?.status).toBe('running')
    finish.resolve()
    await settledRecord(owner, record.id)
  })
})
