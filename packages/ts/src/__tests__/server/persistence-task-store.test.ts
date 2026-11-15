import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createFilesystemPersistence } from '../../persistence/filesystem'
import { PersistenceTaskStore, type TaskRecord } from '../../server'

it('persists concurrent task snapshots in call order and isolates copies across a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-task-snapshots-'))
  const store = new PersistenceTaskStore(createFilesystemPersistence({ directory }))
  const record: TaskRecord = {
    id: 'import',
    type: 'import',
    indexName: 'books',
    owner: 'node',
    status: 'running',
    createdAt: 1,
    progress: { indexed: 0, failed: 0, bytesProcessed: 0, bytesTotal: 100 },
  }
  try {
    const writes = []
    for (let indexed = 0; indexed < 50; indexed++) {
      record.progress = { indexed, failed: 0, bytesProcessed: indexed, bytesTotal: 100 }
      writes.push(store.set(record))
    }
    record.id = 'changed-after-call'
    await store.shutdown()
    const restarted = new PersistenceTaskStore(createFilesystemPersistence({ directory }))
    const saved = await restarted.get('import')
    expect(saved?.progress?.indexed).toBe(49)
    expect(await restarted.get('changed-after-call')).toBeNull()
    await Promise.all(writes)
    if (saved?.progress === undefined) throw new Error('The task has no progress')
    saved.progress.indexed = 1000
    const listed = await restarted.list()
    expect(listed[0]?.progress?.indexed).toBe(49)
    const first = listed[0]
    if (first?.progress === undefined) throw new Error('The task has no progress')
    first.progress.indexed = 2000
    expect((await restarted.get('import'))?.progress?.indexed).toBe(49)
    await restarted.shutdown()
  } finally {
    await store.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
