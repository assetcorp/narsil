import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { NarsilPlugin } from '../../types/plugins'
import type { IndexConfig } from '../../types/schema'

const INDEX = 'notes'
const ARCHIVED_IDS = ['archived-0', 'archived-1', 'archived-2']
const BATCH_SIZE = 2_500
const FIRST_CHUNK_SIZE = 1_000
const CHUNKS_OF_THE_BATCH = [1_000, 1_000, 500]
const WORKERS_OFF = { workers: { enabled: false } } as const
const SEGMENT_BUILDING_WORKERS = { workers: { enabled: true, count: 2, promotionThreshold: 1 } } as const

const config: IndexConfig = { schema: { title: 'string' }, partitions: { maxPartitions: 2 } }

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

async function engineWith(settings: NarsilConfig): Promise<Narsil> {
  const engine = await createNarsil(settings)
  engines.push(engine)
  return engine
}

async function archiveOfArchivedNotes(): Promise<Uint8Array> {
  const source = await engineWith(WORKERS_OFF)
  await source.createIndex(INDEX, config)
  for (const id of ARCHIVED_IDS) await source.insert(INDEX, { title: 'archived note' }, id)
  return new Uint8Array(await new Response(await source.snapshot(INDEX)).arrayBuffer())
}

function batchIds(): string[] {
  return Array.from({ length: BATCH_SIZE }, (_, position) => `batch-${position}`)
}

async function presentBatchIds(engine: Narsil): Promise<Set<string>> {
  const found = await engine.query(INDEX, { term: 'batch', limit: BATCH_SIZE })
  return new Set(found.hits.map(hit => hit.id))
}

function restoringOnce(engine: () => Narsil, archive: Uint8Array): () => Promise<void> {
  let restored = false
  return async () => {
    if (restored) return
    restored = true
    await engine().restore(INDEX, archive)
  }
}

describe('a plugin hook that restores the index it was called for', () => {
  it('finishes a batch insert on the restored index and keeps each chunk of hooks in order', async () => {
    const archive = await archiveOfArchivedNotes()
    const calls: string[] = []
    let engine: Narsil | undefined
    const restore = restoringOnce(() => engineOf(engine), archive)
    const plugin: NarsilPlugin = {
      name: 'restoring-after-insert',
      beforeInsert(ctx) {
        calls.push(`before ${ctx.docId}`)
      },
      async afterInsert(ctx) {
        calls.push(`after ${ctx.docId}`)
        await restore()
      },
    }
    engine = await engineWith({ ...WORKERS_OFF, plugins: [plugin] })
    await engine.createIndex(INDEX, config)

    const ids = batchIds()
    const inserted = await engine.insertBatch(
      INDEX,
      ids.map(id => ({ id, title: 'batch note' })),
    )

    expect(inserted.failed).toEqual([])
    expect(inserted.succeeded).toEqual(ids)
    const expectedCalls: string[] = []
    let chunkStart = 0
    for (const chunkSize of CHUNKS_OF_THE_BATCH) {
      const chunk = ids.slice(chunkStart, chunkStart + chunkSize)
      expectedCalls.push(...chunk.map(id => `before ${id}`), ...chunk.map(id => `after ${id}`))
      chunkStart += chunkSize
    }
    expect(calls).toEqual(expectedCalls)
    expect(await presentBatchIds(engine)).toEqual(new Set(ids.slice(FIRST_CHUNK_SIZE)))
    expect((await engine.query(INDEX, { term: 'archived' })).count).toBe(ARCHIVED_IDS.length)
    expect(await engine.countDocuments(INDEX)).toBe(ARCHIVED_IDS.length + BATCH_SIZE - FIRST_CHUNK_SIZE)
  })

  it('writes every document that a segment batch had not recorded into the restored index, once', async () => {
    const archive = await archiveOfArchivedNotes()
    const before = new Map<string, number>()
    const after: string[] = []
    let engine: Narsil | undefined
    let armed = false
    const restore = restoringOnce(() => engineOf(engine), archive)
    const plugin: NarsilPlugin = {
      name: 'restoring-between-segment-chunks',
      beforeInsert(ctx) {
        if (armed) before.set(ctx.docId, (before.get(ctx.docId) ?? 0) + 1)
      },
      async afterInsert(ctx) {
        if (!armed) return
        after.push(ctx.docId)
        await restore()
      },
    }
    engine = await engineWith({ ...SEGMENT_BUILDING_WORKERS, plugins: [plugin] })
    await engine.createIndex(INDEX, config)
    await engine.insert(INDEX, { title: 'seed note' }, 'seed', { wait: true })
    await expect
      .poll(async () => (await engineOf(engine).getMemoryStats()).workerCopies.some(copy => copy.scaledOut))
      .toBe(true)

    const ids = batchIds()
    armed = true
    const inserted = await engine.insertBatch(
      INDEX,
      ids.map(id => ({ id, title: 'batch note' })),
    )
    armed = false

    expect(inserted.failed).toEqual([])
    expect(new Set(inserted.succeeded)).toEqual(new Set(ids))
    expect(new Map([...before].filter(([, count]) => count !== 1))).toEqual(new Map())
    expect(new Set(before.keys())).toEqual(new Set(ids))
    expect([...after].sort()).toEqual([...ids].sort())
    const present = await presentBatchIds(engine)
    const replaced = after.slice(0, after.length - present.size)
    expect(replaced.length).toBeGreaterThan(0)
    expect(new Set(after.slice(replaced.length))).toEqual(present)
    expect(await engine.get(INDEX, 'seed')).toBeUndefined()
    expect(await engine.countDocuments(INDEX)).toBe(ARCHIVED_IDS.length + present.size)
  })

  it.each([
    'insert',
    'update',
    'remove',
  ] as const)('lets a single %s finish when its hook restores the index', async operation => {
    const archive = await archiveOfArchivedNotes()
    let engine: Narsil | undefined
    const restore = restoringOnce(() => engineOf(engine), archive)
    const plugin: NarsilPlugin = {
      name: `restoring-after-${operation}`,
      afterInsert: operation === 'insert' ? restore : undefined,
      afterUpdate: operation === 'update' ? restore : undefined,
      afterRemove: operation === 'remove' ? restore : undefined,
    }
    engine = await engineWith({ ...WORKERS_OFF, plugins: [plugin] })
    await engine.createIndex(INDEX, config)
    if (operation !== 'insert') await engine.insertBatch(INDEX, [{ id: 'written', title: 'written note' }])

    if (operation === 'insert') await engine.insert(INDEX, { title: 'written note' }, 'written')
    if (operation === 'update') await engine.update(INDEX, 'written', { title: 'rewritten note' })
    if (operation === 'remove') await engine.remove(INDEX, 'written')

    expect(await engine.get(INDEX, 'written')).toBeUndefined()
    expect(await engine.countDocuments(INDEX)).toBe(ARCHIVED_IDS.length)
  })

  it('refuses a restore from a rebalance hook and completes the rebalance', async () => {
    const archive = await archiveOfArchivedNotes()
    let refusal: unknown
    let engine: Narsil | undefined
    const plugin: NarsilPlugin = {
      name: 'restoring-on-split',
      async onPartitionSplit() {
        refusal = await engineOf(engine)
          .restore(INDEX, archive)
          .then(
            () => null,
            (error: unknown) => error,
          )
      },
    }
    engine = await engineWith({ ...WORKERS_OFF, plugins: [plugin] })
    await engine.createIndex(INDEX, config)
    await engine.insert(INDEX, { title: 'written note' }, 'written')

    await engine.rebalance(INDEX, 1)

    expect(refusal).toBeInstanceOf(NarsilError)
    expect((refusal as NarsilError).code).toBe(ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE)
    expect(engine.getPartitionStats(INDEX)).toHaveLength(1)
    expect(await engine.get(INDEX, 'written')).toEqual({ title: 'written note' })
    await engine.restore(INDEX, archive)
    expect(await engine.get(INDEX, 'written')).toBeUndefined()
    expect(await engine.countDocuments(INDEX)).toBe(ARCHIVED_IDS.length)
  })
})

function engineOf(engine: Narsil | undefined): Narsil {
  if (engine === undefined) throw new Error('The engine was used before it was created')
  return engine
}
