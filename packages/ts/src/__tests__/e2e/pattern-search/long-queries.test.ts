import { BroadcastChannel } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_FILTER_TESTS } from '../../../filters/constants'
import { MAX_LONG_QUERIES_IN_FLIGHT } from '../../../server/constants'
import type { FilterExpression } from '../../../types/filters'
import { waitFor } from '../../server/helpers'
import { COMMON_TERM, INDEX, operationsCorpus } from './corpus'
import { loadCorpus, type PatternServer, startPatternServer, WORKER_COPIES, WORKERS_BUILT } from './harness'
import { longValueCorpus, repeatedCodePoints, searchBody, timedSearch } from './hostile'

const CRASH_CHANNEL = 'narsil-long-query-thread-crash'
const RECOVERY_TIMEOUT_MS = 60_000
const WRITES_THEN_MOVES = 5
const PAST_THE_QUEUE = 8

interface Announcement {
  threadId: number
  workerId: number
}

function crashingBootstrapModule(): string {
  const source = `import { BroadcastChannel, threadId, workerData } from 'node:worker_threads'
const channel = new BroadcastChannel(${JSON.stringify(CRASH_CHANNEL)})
channel.onmessage = message => {
  if (message.data?.crash === threadId) setTimeout(() => { throw new Error('the test crashed the long-query thread') })
}
channel.unref()
globalThis.narsilCrashChannel = channel
channel.postMessage({ threadId, workerId: workerData?.workerId })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

function costlyTests(count: number): FilterExpression[] {
  return Array.from({ length: count }, (_, at) => ({
    fields: { line: { eq: repeatedCodePoints(0x4e00 + at, 1_000), tolerance: 2 } },
  }))
}

const COSTLY = { or: costlyTests(MAX_FILTER_TESTS) }

describe.skipIf(!WORKERS_BUILT)('searches that a request thread moves to the long-query thread', () => {
  let server: PatternServer
  let channel: BroadcastChannel
  const announced: Announcement[] = []

  beforeAll(async () => {
    channel = new BroadcastChannel(CRASH_CHANNEL)
    channel.onmessage = (message: unknown) => {
      const data = (message as { data?: Partial<Announcement> }).data
      if (typeof data?.threadId === 'number' && typeof data.workerId === 'number') {
        announced.push({ threadId: data.threadId, workerId: data.workerId })
      }
    }
    server = await startPatternServer({ workers: { ...WORKER_COPIES, bootstrapModule: crashingBootstrapModule() } })
    await loadCorpus(server, [...operationsCorpus(2_000, 21), ...longValueCorpus(40, 8_000)])
    expect(server.requestThreads).toBeGreaterThan(0)
  }, 120_000)

  afterAll(async () => {
    channel.close()
    await server.stop()
  })

  async function burst(count: number): Promise<number[]> {
    const answers = await Promise.all(Array.from({ length: count }, () => timedSearch(server, searchBody(COSTLY))))
    for (const answer of answers) expect([200, 429]).toContain(answer.status)
    return answers.map(answer => answer.status)
  }

  it('finds a document written just before the search moved', async () => {
    for (let round = 0; round < WRITES_THEN_MOVES; round++) {
      const id = `written-before-the-move-${round}`
      const sku = `MOVED-${round}`
      const inserted = await server.client.insertBatch(INDEX, [{ id, body: COMMON_TERM, line: 'plain', sku }])
      expect(inserted.failed).toEqual([])
      const result = await server.client.query(INDEX, {
        term: COMMON_TERM,
        filters: { or: [...costlyTests(MAX_FILTER_TESTS - 1), { fields: { sku: { eq: sku } } }] },
        limit: 10,
      })
      expect(result.hits.map(hit => hit.id)).toEqual([id])
    }
  }, 120_000)

  it('frees every queue place after the long-query thread dies holding a full queue', async () => {
    const longWorkerId = Math.max(...announced.map(entry => entry.workerId))
    const longThread = announced.filter(entry => entry.workerId === longWorkerId).at(-1)
    expect(longThread).toBeDefined()

    const pending = burst(MAX_LONG_QUERIES_IN_FLIGHT + PAST_THE_QUEUE)
    const seenBefore = announced.length
    await new Promise(resolve => setTimeout(resolve, 500))
    channel.postMessage({ crash: longThread?.threadId })
    expect(await pending).toContain(429)

    await waitFor(
      async () => announced.slice(seenBefore).some(entry => entry.workerId === longWorkerId),
      RECOVERY_TIMEOUT_MS,
    )
    await waitFor(
      async () => (await burst(MAX_LONG_QUERIES_IN_FLIGHT + PAST_THE_QUEUE)).includes(429),
      RECOVERY_TIMEOUT_MS,
    )

    const atTheCap = await burst(MAX_LONG_QUERIES_IN_FLIGHT)
    expect(atTheCap).toEqual(Array.from({ length: MAX_LONG_QUERIES_IN_FLIGHT }, () => 200))
  }, 300_000)
})
