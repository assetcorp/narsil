import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const INDEX = 'harbour-log'
const WORKER_COUNT = 2
const QUERY_ROUNDS = 3
const RESULT_LIMIT = 10_000
const COPY_WAIT_MS = 30_000
const SLOW_HOOK_MS = 150
const LIVE_ENTRIES_BEFORE_BATCH = 40
const SLOW_BATCH_SIZE = 40
const SLOW_BATCH_HOOK_MS = 40
const PAST_IDLE_FREEZE_MS = 1_300
const SEGMENT_BATCH_COUNT = 9
const SEGMENT_BATCH_SIZE = 70
const SEGMENT_BATCH_HOOK_MS = 3
const FROZEN_TAIL_SIZE = 70
const LATE_UPDATE_HOOK_MS = 2_000
const BATCHES_THAT_TRIGGER_COMPACTION = 8
const CLEAR_DELAYS_AFTER_BATCHES_MS = [0, 1, 2, 3, 4, 6, 8, 12]

const hook: { delayMs: number; applied: ((docId: string) => void) | null } = { delayMs: 0, applied: null }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function entry(id: string, title: string): { id: string; title: string } {
  return { id, title: `harbour ${title}` }
}

function workerConfig(extra: Partial<NarsilConfig> = {}): NarsilConfig {
  return {
    ...extra,
    workers: { enabled: true, count: WORKER_COUNT, promotionThreshold: 2, mainCopyQueries: 'none' },
    plugins: [
      {
        name: 'slow-audit',
        async afterInsert(ctx) {
          hook.applied?.(ctx.docId)
          if (hook.delayMs > 0) await sleep(hook.delayMs)
        },
        async afterUpdate(ctx) {
          hook.applied?.(ctx.docId)
          if (hook.delayMs > 0) await sleep(hook.delayMs)
        },
      },
    ],
  }
}

async function copiesLoaded(narsil: Narsil, indexName: string): Promise<boolean> {
  const stats = await narsil.getMemoryStats()
  return stats.workerCopies.some(copy => copy.indexName === indexName && copy.scaledOut)
}

async function waitForCopies(narsil: Narsil, indexName = INDEX): Promise<void> {
  const deadline = Date.now() + COPY_WAIT_MS
  while (!(await copiesLoaded(narsil, indexName))) {
    if (Date.now() > deadline) throw new Error('The worker copies never loaded')
    await sleep(25)
  }
}

async function engineWithCopies(expected: Map<string, string>, extra?: Partial<NarsilConfig>): Promise<Narsil> {
  const narsil = await createNarsil(workerConfig(extra))
  await narsil.createIndex(INDEX, { schema: { title: 'string' }, language: 'english' })
  const seeds = [entry('seed-0', 'seed zero'), entry('seed-1', 'seed one'), entry('seed-2', 'seed two')]
  await narsil.insertBatch(INDEX, seeds)
  for (const seed of seeds) expected.set(seed.id, seed.title)
  await waitForCopies(narsil)
  return narsil
}

async function expectEveryCopyHolds(narsil: Narsil, expected: Map<string, string>, indexName = INDEX): Promise<void> {
  await narsil.waitForWrites(indexName)
  const want = Object.fromEntries([...expected].sort(([a], [b]) => a.localeCompare(b)))
  for (let round = 0; round < QUERY_ROUNDS; round++) {
    const answers = await Promise.all(
      Array.from({ length: WORKER_COUNT }, () => narsil.query(indexName, { term: 'harbour', limit: RESULT_LIMIT })),
    )
    for (const answer of answers) {
      const ids = answer.hits.map(hit => hit.id)
      expect(new Set(ids).size).toBe(ids.length)
      const held = Object.fromEntries(
        answer.hits.map(hit => [hit.id, String(hit.document.title)]).sort(([a], [b]) => a.localeCompare(b)),
      )
      expect(held).toEqual(want)
    }
  }
}

function mainHolds(ids: readonly string[]): Promise<void> {
  const waiting = new Set(ids)
  return new Promise<void>(resolve => {
    hook.applied = docId => {
      waiting.delete(docId)
      if (waiting.size === 0) resolve()
    }
  })
}

async function insertOnceMainHolds(narsil: Narsil, id: string): Promise<{ inserting: Promise<string> }> {
  hook.delayMs = SLOW_HOOK_MS
  const applied = mainHolds([id])
  const inserting = narsil.insert(INDEX, entry(id, 'first draft'))
  await applied
  return { inserting }
}

let engine: Narsil | null = null
const directories: string[] = []

afterEach(async () => {
  hook.delayMs = 0
  hook.applied = null
  await engine?.shutdown()
  engine = null
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe.skipIf(!built)('worker copies apply writes in the order that the main copy applied them', () => {
  it('keeps a deleted document off every copy when the delete overtakes the insert it follows', async () => {
    const expected = new Map<string, string>()
    const narsil = await engineWithCopies(expected)
    engine = narsil

    const { inserting } = await insertOnceMainHolds(narsil, 'late-entry')
    await narsil.remove(INDEX, 'late-entry')
    await inserting

    await expectEveryCopyHolds(narsil, expected)
  }, 60_000)

  it('keeps a document deleted after an idle freeze off every copy while the batch that wrote it is still running', async () => {
    const expected = new Map<string, string>()
    const narsil = await engineWithCopies(expected)
    engine = narsil

    for (let i = 0; i < LIVE_ENTRIES_BEFORE_BATCH; i++) {
      const live = entry(`live-${i}`, `live ${i}`)
      await narsil.insert(INDEX, live)
      expected.set(live.id, live.title)
    }
    const batch = Array.from({ length: SLOW_BATCH_SIZE }, (_, i) => entry(`batch-${i}`, `batch ${i}`))
    for (const document of batch) expected.set(document.id, document.title)

    hook.delayMs = SLOW_BATCH_HOOK_MS
    const inserting = narsil.insertBatch(INDEX, batch)
    await sleep(PAST_IDLE_FREEZE_MS)
    await narsil.remove(INDEX, 'batch-0')
    expected.delete('batch-0')
    await narsil.update(INDEX, 'batch-1', entry('batch-1', 'batch one revised'))
    expected.set('batch-1', 'harbour batch one revised')
    const result = await inserting
    hook.delayMs = 0
    expect(result.failed).toEqual([])

    await expectEveryCopyHolds(narsil, expected)
  }, 60_000)

  it('keeps a document that the copy froze before a late update reached it in one place, and keeps a deleted one off', async () => {
    const expected = new Map<string, string>()
    const narsil = await engineWithCopies(expected)
    engine = narsil

    for (let i = 0; i < FROZEN_TAIL_SIZE; i++) {
      const tail = entry(`tail-${i}`, `tail ${i}`)
      await narsil.insert(INDEX, tail)
      expected.set(tail.id, tail.title)
    }

    hook.delayMs = LATE_UPDATE_HOOK_MS
    const updated = mainHolds(['tail-0', 'tail-1'])
    const revisions = [
      narsil.update(INDEX, 'tail-0', entry('tail-0', 'tail zero revised')),
      narsil.update(INDEX, 'tail-1', entry('tail-1', 'tail one revised')),
    ]
    await updated
    expected.set('tail-0', 'harbour tail zero revised')
    await narsil.remove(INDEX, 'tail-1')
    expected.delete('tail-1')
    await sleep(PAST_IDLE_FREEZE_MS)
    await Promise.all(revisions)
    hook.delayMs = 0

    await expectEveryCopyHolds(narsil, expected)
  }, 60_000)

  it('keeps a cleared index empty on every copy when the clear lands while its segments are being compacted', async () => {
    const narsil = await engineWithCopies(new Map())
    engine = narsil

    const outcomes: Array<{ indexName: string; expected: Map<string, string> }> = []
    for (const [attempt, delayMs] of CLEAR_DELAYS_AFTER_BATCHES_MS.entries()) {
      const indexName = `${INDEX}-cleared-${attempt}`
      await narsil.createIndex(indexName, { schema: { title: 'string' }, language: 'english' })
      await narsil.insertBatch(indexName, [entry('seed-0', 'seed zero'), entry('seed-1', 'seed one')])
      await waitForCopies(narsil, indexName)
      for (let round = 0; round < BATCHES_THAT_TRIGGER_COMPACTION; round++) {
        const batch = Array.from({ length: SEGMENT_BATCH_SIZE }, (_, i) =>
          entry(`cleared-${round}-${i}`, `cleared ${round} ${i}`),
        )
        const result = await narsil.insertBatch(indexName, batch)
        expect(result.failed).toEqual([])
      }
      if (delayMs > 0) await sleep(delayMs)
      await narsil.clear(indexName)
      const kept = entry('kept', 'kept after clear')
      await narsil.insert(indexName, kept)
      outcomes.push({ indexName, expected: new Map([[kept.id, kept.title]]) })
    }
    await sleep(PAST_IDLE_FREEZE_MS)

    for (const { indexName, expected } of outcomes) {
      expect(await narsil.get(indexName, 'cleared-0-0')).toBeUndefined()
      await expectEveryCopyHolds(narsil, expected, indexName)
    }
  }, 120_000)

  it('matches the main copy when segment batches race edits to their own documents, through compaction and a reopen from disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-copy-order-'))
    directories.push(directory)
    const durability = { durability: { directory, mode: 'async' as const } }
    const expected = new Map<string, string>()
    let narsil = await engineWithCopies(expected, durability)
    engine = narsil

    for (let round = 0; round < SEGMENT_BATCH_COUNT; round++) {
      const batch = Array.from({ length: SEGMENT_BATCH_SIZE }, (_, i) =>
        entry(`round-${round}-${i}`, `round ${round} entry ${i}`),
      )
      for (const document of batch) expected.set(document.id, document.title)
      const removed = `round-${round}-0`
      const revised = entry(`round-${round}-1`, `round ${round} revised`)
      hook.delayMs = SEGMENT_BATCH_HOOK_MS
      const recorded = mainHolds([removed, revised.id])
      const inserting = narsil.insertBatch(INDEX, batch)
      await recorded
      hook.applied = null
      const edits: Promise<unknown>[] = [narsil.remove(INDEX, removed), narsil.update(INDEX, revised.id, revised)]
      expected.delete(removed)
      expected.set(revised.id, revised.title)
      if (round > 0) {
        const earlier = entry(`round-${round - 1}-2`, `round ${round - 1} revised again`)
        edits.push(narsil.update(INDEX, earlier.id, earlier))
        expected.set(earlier.id, earlier.title)
      }
      await Promise.all(edits)
      const result = await inserting
      expect(result.failed).toEqual([])
    }
    hook.delayMs = 0
    await expectEveryCopyHolds(narsil, expected)

    await narsil.shutdown()
    engine = null
    narsil = await createNarsil(workerConfig(durability))
    engine = narsil
    await narsil.query(INDEX, { term: 'harbour', limit: 1 })
    await waitForCopies(narsil)
    await expectEveryCopyHolds(narsil, expected)
  }, 120_000)
})
