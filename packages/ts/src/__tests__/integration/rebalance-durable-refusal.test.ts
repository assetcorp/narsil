import { renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { registerTokenizer } from '../../analysis/registry'
import { createNarsil } from '../../narsil'
import type { BatchResult } from '../../types/results'

it.each([
  'insert',
  'insertBatch',
  'update',
  'updateBatch',
  'remove',
  'removeBatch',
] as const)('keeps an unacknowledged %s out of replay after its durable append fails', async action => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-queued-durability-'))
  const moved = `${directory}-moved`
  let armed = false
  let relocated = false
  registerTokenizer('queued-durable-refusal', {
    tokenize(text) {
      if (armed && text === (action.startsWith('remove') ? 'river' : 'forest')) {
        renameSync(directory, moved)
        relocated = true
        armed = false
      }
      return [{ token: text, position: 0 }]
    },
  })
  let refused: unknown
  const engine = await createNarsil({
    durability: { directory, mode: 'sync' },
    workers: { enabled: false },
    plugins: [
      {
        name: 'queued-durable-refusal',
        async onPartitionSplit() {
          armed = true
          try {
            if (action === 'insert') await engine.insert('readings', { title: 'forest' }, 'new-reading')
            else if (action === 'update') await engine.update('readings', 'reading', { title: 'forest' })
            else if (action === 'remove') await engine.remove('readings', 'reading')
            else {
              const result =
                action === 'insertBatch'
                  ? await engine.insertBatch('readings', [{ id: 'new-reading', title: 'forest' }])
                  : action === 'updateBatch'
                    ? await engine.updateBatch('readings', [{ docId: 'reading', document: { title: 'forest' } }])
                    : await engine.removeBatch('readings', ['reading'])
              expect(result.succeeded).toEqual([])
              refused = result.failed[0]?.error
            }
          } catch (error) {
            refused = error
          }
        },
      },
    ],
  })
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string' },
      tokenizer: 'queued-durable-refusal',
      partitions: { maxPartitions: 2 },
    })
    await engine.insert('readings', { title: 'river' }, 'reading')
    await expect(engine.rebalance('readings', 1)).rejects.toBeDefined()
    expect(relocated).toBe(true)
    expect(refused).toMatchObject({ code: 'PERSISTENCE_SAVE_FAILED' })
    expect(await engine.get('readings', 'reading')).toEqual({ title: 'river' })
    expect(await engine.get('readings', 'new-reading')).toBeUndefined()
    expect((await engine.query('readings', { term: 'forest' })).count).toBe(0)
  } finally {
    await engine.shutdown().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
    await rm(moved, { recursive: true, force: true })
  }
})

it('replays a later acknowledged partition write after another queued append fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-queued-partition-refusal-'))
  let armed = false
  registerTokenizer('queued-partition-refusal', {
    tokenize(text) {
      if (armed && text === 'blocked') {
        writeFileSync(join(directory, 'readings', 'wal', '1'), 'unavailable')
        armed = false
      }
      return [{ token: text, position: 0 }]
    },
  })
  let result: BatchResult | undefined
  const engine = await createNarsil({
    durability: { directory, mode: 'async', checkpointIntervalMs: 0, flushIntervalMs: 0 },
    workers: { enabled: false },
    plugins: [
      {
        name: 'queued-partition-refusal',
        async onPartitionSplit() {
          armed = true
          result = await engine.insertBatch('readings', [
            { id: 'b', title: 'blocked' },
            { id: 'a', title: 'forest' },
          ])
        },
      },
    ],
  })
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string' },
      tokenizer: 'queued-partition-refusal',
      partitions: { maxPartitions: 2 },
    })
    await engine.insert('readings', { title: 'river' }, 'original')
    await expect(engine.rebalance('readings', 1)).rejects.toBeDefined()
    expect(result?.succeeded).toEqual(['a'])
    expect(result?.failed.map(failure => failure.docId)).toEqual(['b'])
    expect(await engine.get('readings', 'b')).toBeUndefined()
    expect(await engine.get('readings', 'a')).toMatchObject({ title: 'forest' })
    expect((await engine.query('readings', { term: 'forest' })).hits.map(hit => hit.id)).toEqual(['a'])
    await expect(engine.insert('readings', { title: 'later' }, 'later')).rejects.toBeDefined()
  } finally {
    await engine.shutdown().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
