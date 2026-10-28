import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, isNarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import {
  type Ask,
  type AskDuringChange,
  expectFilteredAnswers,
  expectSoundAnswersWhile,
  INDEX,
  type Library,
  nearCentre,
  papersFrom,
  queries,
  randomShelf,
  type ShelvedPaper,
  selectivities,
  shelvesConfig,
  vectorQuery,
} from './library'
import { BACKEND_NAMES, backendAvailable, type SearchBackend, searchThrough } from './search-backend'

const BATCHES = 10
const BATCH_SIZE = 200
const UPDATED_EACH_WAY = 100
const REMOVED = 200
const REEMBEDDED_BEFORE_RESTORE = 200
const REFILLED = 1_500
const PARTITIONS_AFTER_REBALANCE = 3
const SETTLE_DEADLINE_MS = 60_000
const REFUSALS_WHILE_RESTORING: ReadonlySet<string> = new Set([ErrorCodes.INDEX_NOT_FOUND])

const built = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))

const threadModes = [
  { name: 'on the main thread alone', workers: { enabled: false }, copied: false },
  { name: 'with worker copies and the search pool', workers: { count: 2 }, copied: true },
] satisfies { name: string; workers: NarsilConfig['workers']; copied: boolean }[]

function askOf(narsil: Narsil): Ask {
  return async (query, filters) => {
    const result = await narsil.query(INDEX, vectorQuery(query, filters))
    return result.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
  }
}

function askDuringChangeOf(narsil: Narsil): AskDuringChange {
  const ask = askOf(narsil)
  return async (query, filters) => {
    try {
      return { hits: await ask(query, filters) }
    } catch (err) {
      if (isNarsilError(err)) return { refusedWith: err.code }
      throw err
    }
  }
}

async function untilSettled(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (
    narsil
      .vectorMaintenanceStatus(INDEX)
      .some(field => field.building || field.graphCount === 0 || field.bufferSize > 0)
  ) {
    if (Date.now() > deadline) throw new Error(`the graph of ${INDEX} was still building after 60 s`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function untilEveryWorkerHoldsACopy(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  for (;;) {
    await narsil.query(INDEX, vectorQuery(queries[0], selectivities[0].filters))
    const stats = await narsil.getMemoryStats()
    if (stats.workerCopies.some(report => report.indexName === INDEX && report.scaledOut)) return
    if (Date.now() > deadline) throw new Error(`the workers still held no copy of ${INDEX} after 60 s`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function insertInto(narsil: Narsil, library: Library, papers: ShelvedPaper[]): Promise<void> {
  const result = await narsil.insertBatch(INDEX, papers)
  expect(result.failed).toEqual([])
  for (const paper of papers) library.set(paper.id, paper)
}

async function updateIn(narsil: Narsil, library: Library, papers: ShelvedPaper[]): Promise<void> {
  const result = await narsil.updateBatch(
    INDEX,
    papers.map(paper => ({ docId: paper.id, document: paper })),
  )
  expect(result.failed).toEqual([])
  for (const paper of papers) library.set(paper.id, paper)
}

function changedPapers(library: Library, from: number): ShelvedPaper[] {
  const held = [...library.values()].slice(from, from + 3 * UPDATED_EACH_WAY)
  return held.map((paper, i) => {
    const way = Math.floor(i / UPDATED_EACH_WAY)
    if (way === 0) return { ...paper, shelf: randomShelf() }
    if (way === 1) return { ...paper, embedding: nearCentre() }
    return { ...paper, shelf: randomShelf(), embedding: nearCentre() }
  })
}

export function describeFilteredMutations(backend: SearchBackend): void {
  searchThrough(backend)

  describe(`filtered vector searches through ${BACKEND_NAMES[backend]}`, () => {
    let narsil: Narsil | null = null
    let directory = ''

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'narsil-filtered-vectors-'))
    })

    afterEach(async () => {
      await narsil?.shutdown()
      narsil = null
      await rm(directory, { recursive: true, force: true })
    })

    it.skipIf(!backendAvailable(backend) || !built).each(threadModes)(
      'match a brute-force oracle across writes, compactions, a rebalance, a restart, a restore, and a clear $name',
      async ({ workers, copied }) => {
        const crashes: string[] = []
        const config: NarsilConfig = {
          workers,
          durability: { directory },
          events: { workerCrash: crash => crashes.push(crash.error.message) },
        }
        let opened = await createNarsil(config)
        narsil = opened
        await opened.createIndex(INDEX, shelvesConfig)
        let library: Library = new Map()
        for (let batch = 0; batch < BATCHES; batch++) {
          await insertInto(opened, library, papersFrom(batch * BATCH_SIZE, BATCH_SIZE))
        }
        await untilSettled(opened)
        if (copied) await untilEveryWorkerHoldsACopy(opened)
        await expectFilteredAnswers(askOf(opened), library, 'after batched inserts and segment compaction')

        await updateIn(opened, library, changedPapers(library, 0))
        await expectFilteredAnswers(askOf(opened), library, 'straight after updates')
        await untilSettled(opened)
        await expectFilteredAnswers(askOf(opened), library, 'once the graph takes the updates in')

        const removed = [...library.keys()].slice(3 * UPDATED_EACH_WAY, 3 * UPDATED_EACH_WAY + REMOVED)
        const removal = await opened.removeBatch(INDEX, removed)
        expect(removal.failed).toEqual([])
        for (const id of removed) library.delete(id)
        await expectFilteredAnswers(askOf(opened), library, 'after removals')

        await opened.compactVectors(INDEX)
        await expectFilteredAnswers(askOf(opened), library, 'after a vector compaction')

        await opened.rebalance(INDEX, PARTITIONS_AFTER_REBALANCE)
        await expectFilteredAnswers(askOf(opened), library, 'after a rebalance')
        await updateIn(opened, library, changedPapers(library, 3 * UPDATED_EACH_WAY))
        await expectFilteredAnswers(askOf(opened), library, 'after updates across the new partitions')

        await opened.shutdown()
        opened = await createNarsil(config)
        narsil = opened
        await untilSettled(opened)
        if (copied) await untilEveryWorkerHoldsACopy(opened)
        await expectFilteredAnswers(askOf(opened), library, 'after a restart')

        const archive = new Uint8Array(await new Response(await opened.snapshot(INDEX)).arrayBuffer())
        const snapshotted: Library = new Map(library)
        const reembedded = [...library.values()]
          .slice(0, REEMBEDDED_BEFORE_RESTORE)
          .map(paper => ({ ...paper, embedding: nearCentre() }))
        await updateIn(opened, library, reembedded)
        let restoring = true
        const restore = opened.restore(INDEX, archive).finally(() => {
          restoring = false
        })
        await expectSoundAnswersWhile(
          askDuringChangeOf(opened),
          [library, snapshotted],
          'while a restore replaces the index',
          () => restoring,
          REFUSALS_WHILE_RESTORING,
        )
        await restore
        library = snapshotted
        await untilSettled(opened)
        if (copied) await untilEveryWorkerHoldsACopy(opened)
        await expectFilteredAnswers(askOf(opened), library, 'after the restore')

        let clearing = true
        const clear = opened.clear(INDEX).finally(() => {
          clearing = false
        })
        await expectSoundAnswersWhile(
          askDuringChangeOf(opened),
          [library, new Map()],
          'while a clear runs',
          () => clearing,
          new Set(),
        )
        await clear
        library = new Map()
        await expectFilteredAnswers(askOf(opened), library, 'after the clear')
        await insertInto(opened, library, papersFrom(BATCHES * BATCH_SIZE, REFILLED))
        await untilSettled(opened)
        if (copied) await untilEveryWorkerHoldsACopy(opened)
        await expectFilteredAnswers(askOf(opened), library, 'once the cleared index fills again')

        expect(crashes).toEqual([])
      },
      600_000,
    )
  })
}
