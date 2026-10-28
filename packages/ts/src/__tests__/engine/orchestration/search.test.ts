import { describe, expect, it } from 'vitest'
import { createPatternWorkMeter } from '../../../core/pattern-index/work-meter'
import { MAIN_COPY_LONE_QUERY_DOCUMENTS } from '../../../engine/orchestration/constants'
import { searchViaWorker } from '../../../engine/orchestration/search'
import type { IndexRegistry, OrchestratorState } from '../../../engine/orchestration/types'
import { getLanguage } from '../../../languages/registry'
import type { FanOutResult } from '../../../partitioning/fan-out'
import type { GlobalStatistics } from '../../../types/internal'
import type { IndexConfig } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { type OrchestratorHarness, type RecordedDispatch, recordingHarness, settle } from './fixtures'

const EMPTY: FanOutResult = { scored: [], totalMatched: 0 }

function workerSearch(
  state: OrchestratorState,
  indexName: string,
  params: QueryParams,
  globalStats?: GlobalStatistics,
  partitionIds?: number[],
): Promise<FanOutResult | null> {
  return searchViaWorker(state, indexName, params, globalStats, partitionIds, createPatternWorkMeter())
}

function registryWith(config: IndexConfig): IndexRegistry {
  return new Map([['prose', { config, language: getLanguage('english'), embeddingAdapter: null, synonyms: null }]])
}

function queries(harness: OrchestratorHarness): RecordedDispatch[] {
  return harness.dispatched.filter(entry => entry.action.type === 'query')
}

function partitionsOf(entry: RecordedDispatch): number[] | undefined {
  return entry.action.type === 'query' ? entry.action.partitionIds : undefined
}

describe('a whole query goes to the copy with the fewest queries in flight', () => {
  it('sends a one-partition query to a different idle copy each time while earlier queries are still running', async () => {
    const harness = recordingHarness(3, ['prose'])

    const first = workerSearch(harness.state, 'prose', { term: 'a' })
    const second = workerSearch(harness.state, 'prose', { term: 'b' })
    const third = workerSearch(harness.state, 'prose', { term: 'c' })
    await settle()

    const sent = queries(harness)
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map(entry => entry.workerId)).size).toBe(3)
    for (const entry of sent) expect(partitionsOf(entry)).toBeUndefined()

    harness.releaseAll()
    await Promise.all([first, second, third])
  })

  it('answers on the main copy once every copy is busy, then on the copy that finished first', async () => {
    const harness = recordingHarness(2, ['prose'])

    const first = workerSearch(harness.state, 'prose', { term: 'a' })
    const second = workerSearch(harness.state, 'prose', { term: 'b' })
    await settle()
    const [firstSent, secondSent] = queries(harness)

    expect(await workerSearch(harness.state, 'prose', { term: 'c' })).toBeNull()
    expect(queries(harness)).toHaveLength(2)

    secondSent.resolve(EMPTY)
    await second
    const fourth = workerSearch(harness.state, 'prose', { term: 'd' })
    await settle()
    const fourthSent = queries(harness)[2]
    expect(fourthSent.workerId).toBe(secondSent.workerId)
    expect(fourthSent.workerId).not.toBe(firstSent.workerId)

    firstSent.resolve(EMPTY)
    fourthSent.resolve(EMPTY)
    await Promise.all([first, fourth])
  })

  it('gives the main copy one query per turn of the event loop and queues the rest on the least busy copy', async () => {
    const harness = recordingHarness(2, ['prose'])

    const held = [
      workerSearch(harness.state, 'prose', { term: 'a' }),
      workerSearch(harness.state, 'prose', { term: 'b' }),
    ]
    await settle()
    expect(queries(harness)).toHaveLength(2)

    const overflow = [
      workerSearch(harness.state, 'prose', { term: 'c' }),
      workerSearch(harness.state, 'prose', { term: 'd' }),
      workerSearch(harness.state, 'prose', { term: 'e' }),
    ]
    expect(await overflow[0]).toBeNull()
    expect(queries(harness)).toHaveLength(4)
    expect(
      new Set(
        queries(harness)
          .slice(2)
          .map(entry => entry.workerId),
      ).size,
    ).toBe(2)

    await settle()
    expect(await workerSearch(harness.state, 'prose', { term: 'f' })).toBeNull()
    expect(queries(harness)).toHaveLength(4)

    harness.releaseAll()
    await Promise.all([...held, ...overflow])
  })

  it('keeps sending whole queries when only one copy is idle', async () => {
    const harness = recordingHarness(2, ['prose'], 4)

    const split = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()
    const halves = queries(harness)
    expect(halves).toHaveLength(2)
    halves[0].resolve(EMPTY)
    await settle()

    const next = workerSearch(harness.state, 'prose', { term: 'b' })
    await settle()

    const sent = queries(harness)
    expect(sent).toHaveLength(3)
    expect(partitionsOf(sent[2])).toBeUndefined()
    expect(sent[2].workerId).toBe(halves[0].workerId)

    harness.releaseAll()
    await Promise.all([split, next])
  })
})

describe('a lone query on a small index skips the worker hop', () => {
  it('answers on the main copy and sends nothing to the copies', async () => {
    const harness = recordingHarness(3, ['prose'])
    harness.setDocumentCount(5_000)

    expect(await workerSearch(harness.state, 'prose', { term: 'a' })).toBeNull()
    await settle()
    expect(queries(harness)).toHaveLength(0)
  })

  it('sends the query to a copy once the index outgrows what the main copy answers quickly', async () => {
    const harness = recordingHarness(3, ['prose'])
    harness.setDocumentCount(MAIN_COPY_LONE_QUERY_DOCUMENTS + 1)

    const pending = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()
    expect(queries(harness)).toHaveLength(1)

    harness.releaseAll()
    await pending
  })

  it('sends a small index query to a copy while another query is still running', async () => {
    const harness = recordingHarness(3, ['prose'])

    const large = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()
    const [first] = queries(harness)
    expect(first).toBeDefined()

    harness.setDocumentCount(5_000)
    const small = workerSearch(harness.state, 'prose', { term: 'b' })
    await settle()

    const sent = queries(harness)
    expect(sent).toHaveLength(2)
    expect(sent[1].workerId).not.toBe(first.workerId)

    harness.releaseAll()
    await Promise.all([large, small])
  })
})

describe('the engine sends every query to a copy where the host shares its main thread', () => {
  it('sends a lone query on a small index to a copy', async () => {
    const harness = recordingHarness(3, ['prose'], 1, { mainCopyQueries: 'none' })
    harness.setDocumentCount(5_000)

    const pending = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()
    expect(queries(harness)).toHaveLength(1)

    harness.releaseAll()
    await pending
  })
})

describe('a query naming several partitions may split across idle copies', () => {
  it('gives each idle copy its own partitions and merges the answers', async () => {
    const harness = recordingHarness(2, ['prose'], 4)

    const pending = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()

    const sent = queries(harness)
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map(entry => entry.workerId)).size).toBe(2)
    const covered = sent.flatMap(entry => partitionsOf(entry) ?? []).sort()
    expect(covered).toEqual([0, 1, 2, 3])

    sent[0].resolve({
      scored: [{ docId: 'x', score: 2, termFrequencies: {}, fieldLengths: {}, idf: {} }],
      totalMatched: 1,
    })
    sent[1].resolve({
      scored: [{ docId: 'y', score: 3, termFrequencies: {}, fieldLengths: {}, idf: {} }],
      totalMatched: 1,
    })
    const result = await pending
    expect(result?.totalMatched).toBe(2)
    expect(result?.scored.map(doc => doc.docId)).toEqual(['y', 'x'])
  })

  it('splits only the partitions the caller named', async () => {
    const harness = recordingHarness(3, ['prose'], 6)

    const pending = workerSearch(harness.state, 'prose', { term: 'a' }, undefined, [1, 4])
    await settle()

    const sent = queries(harness)
    expect(sent).toHaveLength(2)
    expect(sent.flatMap(entry => partitionsOf(entry) ?? []).sort()).toEqual([1, 4])

    harness.releaseAll()
    await pending
  })

  it('never splits a query whose scoring needs statistics over every partition', async () => {
    const harness = recordingHarness(2, ['prose'], 4, {
      indexRegistry: registryWith({ schema: { title: 'string' }, defaultScoring: 'dfs' }),
    })

    const pending = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()

    const sent = queries(harness)
    expect(sent).toHaveLength(1)
    expect(partitionsOf(sent[0])).toBeUndefined()

    harness.releaseAll()
    await pending
  })

  it('splits a broadcast query once the caller supplies the merged statistics', async () => {
    const harness = recordingHarness(2, ['prose'], 4, {
      indexRegistry: registryWith({ schema: { title: 'string' }, defaultScoring: 'broadcast' }),
    })
    const stats: GlobalStatistics = {
      totalDocuments: 10,
      docFrequencies: {},
      totalFieldLengths: {},
      averageFieldLengths: {},
    }

    const withoutStats = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()
    expect(queries(harness)).toHaveLength(1)
    harness.releaseAll()
    await withoutStats

    const withStats = workerSearch(harness.state, 'prose', { term: 'a' }, stats)
    await settle()
    expect(queries(harness)).toHaveLength(2)

    harness.releaseAll()
    await withStats
  })
})

describe('a copy answers only once it holds every write', () => {
  it('answers from the main copy while a copy is still loading', async () => {
    const harness = recordingHarness(2, [], 1)
    harness.state.copyLoadBuffers.set('prose', [])

    expect(await workerSearch(harness.state, 'prose', { term: 'a' })).toBeNull()
  })

  it('falls back to the main copy when the copy fails mid-query', async () => {
    const harness = recordingHarness(1, ['prose'])

    const pending = workerSearch(harness.state, 'prose', { term: 'a' })
    await settle()
    queries(harness)[0].reject(new Error('worker gone'))

    expect(await pending).toBeNull()
  })
})
