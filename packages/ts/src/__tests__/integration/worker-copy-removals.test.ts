import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { scaledOut, waitFor } from '../server/helpers'

const WORKERS_BUILT = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))
const INDEX = 'harbour-log'
const WORKER_COUNT = 2
const PROMOTION_THRESHOLD = 2
const RESTORED_ENTRIES = 300
const SINGLE_REMOVAL_ROUNDS = 12
const RESTORED_STRIDE = 7
const BATCH_ROUNDS = 4
const BATCH_TAIL_ENTRIES = 6
const BATCH_RESTORED_ENTRIES = 30
const QUERIES_PER_CHECK = WORKER_COUNT * 2
const RESULT_LIMIT = 10_000
const COPY_WAIT_MS = 30_000
const NEVER_WRITTEN = 'never-written'
const SPELLINGS = ['sailing', 'moored', 'anchors', 'harbours', 'docking']

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function logEntry(id: string, at: number): { id: string; title: string } {
  return { id, title: `harbour ${SPELLINGS[at % SPELLINGS.length]} vessel ${at}` }
}

async function restoredWithCopies(present: Set<string>): Promise<Narsil> {
  const builder = await createNarsil({ workers: { enabled: false } })
  await builder.createIndex(INDEX, { schema: { title: 'string' }, language: 'english' })
  const rows = Array.from({ length: RESTORED_ENTRIES }, (_, at) => logEntry(`restored-${at}`, at))
  expect((await builder.insertBatch(INDEX, rows)).failed).toEqual([])
  const archive = new Uint8Array(await new Response(await builder.snapshot(INDEX)).arrayBuffer())
  await builder.shutdown()

  const engine = await createNarsil({
    workers: {
      enabled: true,
      count: WORKER_COUNT,
      promotionThreshold: PROMOTION_THRESHOLD,
      mainCopyQueries: 'none',
    },
  })
  engines.push(engine)
  await engine.restore(INDEX, archive)
  for (const row of rows) present.add(row.id)
  await waitFor(async () => {
    await engine.query(INDEX, { term: 'harbour' })
    return scaledOut(engine, INDEX)
  }, COPY_WAIT_MS)
  return engine
}

async function expectCopiesAnswerWith(engine: Narsil, present: ReadonlySet<string>): Promise<void> {
  const want = [...present].sort()
  const answers = await Promise.all(
    Array.from({ length: QUERIES_PER_CHECK }, () => engine.query(INDEX, { term: 'harbour', limit: RESULT_LIMIT })),
  )
  for (const answer of answers) expect(answer.hits.map(hit => hit.id).sort()).toEqual(want)
  expect(await engine.countDocuments(INDEX)).toBe(present.size)
}

describe.skipIf(!WORKERS_BUILT)('a query on a worker copy straight after a removal that waits for the copies', () => {
  it('never returns a removed document, including one inserted into the live tail just before the removal', async () => {
    const present = new Set<string>()
    const engine = await restoredWithCopies(present)

    for (let round = 0; round < SINGLE_REMOVAL_ROUNDS; round++) {
      const kept = logEntry(`kept-${round}`, round)
      const fleeting = logEntry(`fleeting-${round}`, round + 1)
      await engine.insert(INDEX, kept)
      present.add(kept.id)
      await engine.insert(INDEX, fleeting)
      await engine.remove(INDEX, fleeting.id, { wait: true })
      await expectCopiesAnswerWith(engine, present)

      const restoredId = `restored-${round * RESTORED_STRIDE}`
      await engine.remove(INDEX, restoredId, { wait: true })
      present.delete(restoredId)
      await expectCopiesAnswerWith(engine, present)
    }
  }, 120_000)

  it('never returns a document that removeBatch removed from the live tail or the restored segments', async () => {
    const present = new Set<string>()
    const engine = await restoredWithCopies(present)

    for (let round = 0; round < BATCH_ROUNDS; round++) {
      const fleeting = Array.from({ length: BATCH_TAIL_ENTRIES }, (_, at) =>
        logEntry(`fleeting-${round}-${at}`, round * BATCH_TAIL_ENTRIES + at),
      )
      for (const row of fleeting) await engine.insert(INDEX, row)
      const firstRestored = round * BATCH_RESTORED_ENTRIES
      const restoredIds = Array.from({ length: BATCH_RESTORED_ENTRIES }, (_, at) => `restored-${firstRestored + at}`)
      const removing = [...fleeting.map(row => row.id), ...restoredIds]
      const waitsOnTheWrite = round % 2 === 0

      const result = await engine.removeBatch(
        INDEX,
        [...removing, NEVER_WRITTEN],
        waitsOnTheWrite ? { wait: true } : undefined,
      )
      if (!waitsOnTheWrite) await engine.waitForWrites(INDEX)

      expect(result.failed.map(failure => failure.docId)).toEqual([NEVER_WRITTEN])
      expect([...result.succeeded].sort()).toEqual([...removing].sort())
      for (const id of restoredIds) present.delete(id)
      await expectCopiesAnswerWith(engine, present)
    }
  }, 120_000)
})
