import { describe, expect, it } from 'vitest'
import { InMemoryTaskStore } from '../../server'
import type { TaskRecord } from '../../server/types'

function taskRecord(id: string, status: TaskRecord['status']): TaskRecord {
  return { id, type: 'import', indexName: 'movies', owner: 'test', status, createdAt: 1, startedAt: 1 }
}

describe('the default task store', () => {
  it('drops a cancelled record once the store is full', async () => {
    const store = new InMemoryTaskStore(2)

    await store.set(taskRecord('a', 'cancelled'))
    await store.set(taskRecord('b', 'cancelled'))
    await store.set(taskRecord('c', 'running'))

    expect(await store.get('a')).toBeNull()
    expect(await store.get('c')).not.toBeNull()
  })

  it('keeps a running record while it drops finished ones', async () => {
    const store = new InMemoryTaskStore(1)

    await store.set(taskRecord('running', 'running'))
    await store.set(taskRecord('done', 'succeeded'))

    expect(await store.get('running')).not.toBeNull()
  })
})
