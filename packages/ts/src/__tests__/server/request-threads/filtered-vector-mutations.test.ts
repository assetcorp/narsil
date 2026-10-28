import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import type { Narsil } from '../../../narsil'
import type { FilterExpression } from '../../../types/filters'
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
  shelvesConfig,
  vectorQuery,
} from '../../integration/filtered-vectors/library'
import { postJson, startTestServer, type TestServer } from '../helpers'

const DOCUMENTS = 2_000
const INSERT_BATCH_SIZE = 200
const UPDATED_EACH_WAY = 100
const REMOVED = 200
const REEMBEDDED_BEFORE_RESTORE = 200
const PARTITIONS_AFTER_REBALANCE = 3
const THREAD_DEADLINE_MS = 120_000
const PROBES = 8

interface SearchBody {
  hits: Array<{ id: string; score?: number }>
}

interface ErrorBody {
  error: { code: string }
}

const REFUSALS_WHILE_RESTORING: ReadonlySet<string> = new Set([ErrorCodes.INDEX_NOT_FOUND])

const built = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))

describe.skipIf(!built)('filtered vector searches that request threads answer', () => {
  let srv: TestServer
  let mainQueries = 0

  beforeEach(async () => {
    srv = await startTestServer(undefined, { workers: { count: 2 } }, async prepared => {
      const mainQuery = prepared.query.bind(prepared)
      prepared.query = (indexName, params) => {
        mainQueries += 1
        return mainQuery(indexName, params)
      }
    })
  })

  afterEach(async () => {
    await srv.stop()
  })

  const askThreadsDuringChange: AskDuringChange = async (query, filters) => {
    const response = await postJson<SearchBody | ErrorBody>(
      srv.base,
      `/indexes/${INDEX}/search`,
      vectorQuery(query, filters),
    )
    if ('error' in response.body) return { refusedWith: response.body.error.code }
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    return { hits: response.body.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN })) }
  }

  const askThreads: Ask = async (query, filters) => {
    const answer = await askThreadsDuringChange(query, filters)
    if ('refusedWith' in answer) throw new Error(`the search was refused with ${answer.refusedWith}`)
    return answer.hits
  }

  async function write(action: 'insert' | 'update' | 'delete', papers: ShelvedPaper[], library: Library) {
    const options = { wait: true }
    let body: Record<string, unknown> = { action, documents: papers, options }
    if (action === 'delete') body = { action, docIds: papers.map(paper => paper.id), options }
    if (action === 'update')
      body = { action, updates: papers.map(paper => ({ docId: paper.id, document: paper })), options }
    const written = await postJson<{ failed: unknown[] }>(srv.base, `/indexes/${INDEX}/documents/_batch`, body)
    expect(written.status, JSON.stringify(written.body)).toBe(200)
    expect(written.body.failed).toEqual([])
    for (const paper of papers) {
      if (action === 'delete') library.delete(paper.id)
      else library.set(paper.id, paper)
    }
  }

  async function untilThreadsAnswer(): Promise<void> {
    const deadline = Date.now() + THREAD_DEADLINE_MS
    const filters: FilterExpression = { fields: { shelf: { lt: 25 } } }
    for (;;) {
      const before = mainQueries
      await Promise.all(Array.from({ length: PROBES }, (_, i) => askThreads(queries[i % queries.length], filters)))
      if (mainQueries === before) return
      if (Date.now() > deadline) throw new Error('the request threads never came to answer filtered vector searches')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  async function expectOnThreads(library: Library, stage: string): Promise<void> {
    await untilThreadsAnswer()
    const before = mainQueries
    await expectFilteredAnswers(askThreads, library, `${stage} on the request threads`)
    expect(mainQueries, `queries that fell back to the main thread ${stage}`).toBe(before)
  }

  function changedPapers(library: Library, from: number): ShelvedPaper[] {
    return [...library.values()].slice(from, from + 3 * UPDATED_EACH_WAY).map((paper, i) => {
      const way = Math.floor(i / UPDATED_EACH_WAY)
      if (way === 0) return { ...paper, shelf: randomShelf() }
      if (way === 1) return { ...paper, embedding: nearCentre() }
      return { ...paper, shelf: randomShelf(), embedding: nearCentre() }
    })
  }

  it('match a brute-force oracle across writes, a vector compaction, a rebalance, a restore, and a clear', async () => {
    const engine: Narsil = srv.engine
    const created = await postJson(srv.base, '/indexes', { name: INDEX, config: shelvesConfig })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    let library: Library = new Map()
    const papers = papersFrom(0, DOCUMENTS)
    for (let start = 0; start < DOCUMENTS; start += INSERT_BATCH_SIZE) {
      await write('insert', papers.slice(start, start + INSERT_BATCH_SIZE), library)
    }
    await expectOnThreads(library, 'after batched inserts')

    await write('update', changedPapers(library, 0), library)
    await expectFilteredAnswers(askThreads, library, 'straight after updates')
    await expectOnThreads(library, 'after updates')

    const removed = [...library.values()].slice(3 * UPDATED_EACH_WAY, 3 * UPDATED_EACH_WAY + REMOVED)
    await write('delete', removed, library)
    await expectFilteredAnswers(askThreads, library, 'straight after removals')

    await engine.compactVectors(INDEX)
    await expectOnThreads(library, 'after a vector compaction')

    await engine.rebalance(INDEX, PARTITIONS_AFTER_REBALANCE)
    await expectFilteredAnswers(askThreads, library, 'straight after a rebalance')
    await expectOnThreads(library, 'after a rebalance')
    await write('update', changedPapers(library, 3 * UPDATED_EACH_WAY), library)
    await expectOnThreads(library, 'after updates across the new partitions')

    const archive = new Uint8Array(await new Response(await engine.snapshot(INDEX)).arrayBuffer())
    const snapshotted: Library = new Map(library)
    const reembedded = [...library.values()]
      .slice(0, REEMBEDDED_BEFORE_RESTORE)
      .map(paper => ({ ...paper, embedding: nearCentre() }))
    await write('update', reembedded, library)
    let restoring = true
    const restore = engine.restore(INDEX, archive).finally(() => {
      restoring = false
    })
    await expectSoundAnswersWhile(
      askThreadsDuringChange,
      [library, snapshotted],
      'while a restore replaces the index',
      () => restoring,
      REFUSALS_WHILE_RESTORING,
    )
    await restore
    library = snapshotted
    await expectOnThreads(library, 'after the restore')

    let clearing = true
    const clear = engine.clear(INDEX).finally(() => {
      clearing = false
    })
    await expectSoundAnswersWhile(
      askThreadsDuringChange,
      [library, new Map()],
      'while a clear runs',
      () => clearing,
      new Set(),
    )
    await clear
    library = new Map()
    await expectFilteredAnswers(askThreads, library, 'after the clear')
    const refill = papersFrom(DOCUMENTS, DOCUMENTS)
    for (let start = 0; start < DOCUMENTS; start += INSERT_BATCH_SIZE) {
      await write('insert', refill.slice(start, start + INSERT_BATCH_SIZE), library)
    }
    await expectOnThreads(library, 'once the cleared index fills again')
  }, 600_000)
})
