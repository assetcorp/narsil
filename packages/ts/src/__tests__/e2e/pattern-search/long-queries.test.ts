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

interface HeldOverfill {
  answeredWhileHeld: number
  refusedWhileHeld: number
  statuses: number[]
}

interface Burst {
  refused: () => number
  answered: () => number
  statuses: Promise<number[]>
}

function holdingBootstrapModule(): string {
  const source = `import { BroadcastChannel, threadId, workerData } from 'node:worker_threads'
const channel = new BroadcastChannel(${JSON.stringify(CRASH_CHANNEL)})
channel.onmessage = message => {
  if (message.data?.hold !== threadId) return
  const gate = new Int32Array(message.data.gate)
  channel.postMessage({ held: threadId })
  Atomics.wait(gate, 0, 0)
  if (message.data.crash) throw new Error('the test crashed the long-query thread while it held a full queue')
}
channel.unref()
globalThis.narsilCrashChannel = channel
channel.postMessage({ threadId, workerId: workerData?.workerId })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

function openGate(gate: Int32Array): void {
  Atomics.store(gate, 0, 1)
  Atomics.notify(gate, 0)
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
  const held = new Set<number>()

  beforeAll(async () => {
    channel = new BroadcastChannel(CRASH_CHANNEL)
    channel.onmessage = (message: unknown) => {
      const data = (message as { data?: Partial<Announcement> & { held?: number } }).data
      if (typeof data?.held === 'number') held.add(data.held)
      if (typeof data?.threadId === 'number' && typeof data.workerId === 'number') {
        announced.push({ threadId: data.threadId, workerId: data.workerId })
      }
    }
    server = await startPatternServer({ workers: { ...WORKER_COPIES, bootstrapModule: holdingBootstrapModule() } })
    await loadCorpus(server, [...operationsCorpus(2_000, 21), ...longValueCorpus(40, 8_000)])
    expect(server.requestThreads).toBeGreaterThan(0)
  }, 120_000)

  afterAll(async () => {
    channel.close()
    await server.stop()
  })

  function startBurst(count: number): Burst {
    let refused = 0
    let answered = 0
    const statuses = Promise.all(
      Array.from({ length: count }, async () => {
        const answer = await timedSearch(server, searchBody(COSTLY))
        answered++
        if (answer.status === 429) refused++
        return answer.status
      }),
    )
    return { refused: () => refused, answered: () => answered, statuses }
  }

  async function burst(count: number): Promise<number[]> {
    const statuses = await startBurst(count).statuses
    for (const status of statuses) expect([200, 429]).toContain(status)
    return statuses
  }

  async function overfillWhileHeld(threadId: number, crash: boolean): Promise<HeldOverfill> {
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    held.delete(threadId)
    channel.postMessage({ hold: threadId, gate: gate.buffer, crash })
    try {
      await waitFor(async () => held.has(threadId), RECOVERY_TIMEOUT_MS)
      const overfill = startBurst(MAX_LONG_QUERIES_IN_FLIGHT + PAST_THE_QUEUE)
      await waitFor(async () => overfill.answered() >= PAST_THE_QUEUE, RECOVERY_TIMEOUT_MS)
      const answeredWhileHeld = overfill.answered()
      const refusedWhileHeld = overfill.refused()
      openGate(gate)
      const statuses = await overfill.statuses
      for (const status of statuses) expect([200, 429]).toContain(status)
      return { answeredWhileHeld, refusedWhileHeld, statuses }
    } finally {
      openGate(gate)
    }
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
    if (longThread === undefined) throw new Error('the long-query thread never announced itself')

    const seenBefore = announced.length
    const beforeDeath = await overfillWhileHeld(longThread.threadId, true)
    expect({ answered: beforeDeath.answeredWhileHeld, refused: beforeDeath.refusedWhileHeld }).toEqual({
      answered: PAST_THE_QUEUE,
      refused: PAST_THE_QUEUE,
    })

    await waitFor(
      async () => announced.slice(seenBefore).some(entry => entry.workerId === longWorkerId),
      RECOVERY_TIMEOUT_MS,
    )
    const replacement = announced.slice(seenBefore).filter(entry => entry.workerId === longWorkerId)
    const replacementThread = replacement.at(-1)
    if (replacementThread === undefined) throw new Error('no long-query thread replaced the one that died')
    let afterRecovery: HeldOverfill = { answeredWhileHeld: 0, refusedWhileHeld: 0, statuses: [] }
    await waitFor(async () => {
      afterRecovery = await overfillWhileHeld(replacementThread.threadId, false)
      return afterRecovery.refusedWhileHeld > 0 && afterRecovery.refusedWhileHeld === afterRecovery.answeredWhileHeld
    }, RECOVERY_TIMEOUT_MS)
    expect(afterRecovery.statuses.filter(status => status === 429)).toHaveLength(PAST_THE_QUEUE)

    const atTheCap = await burst(MAX_LONG_QUERIES_IN_FLIGHT)
    expect(atTheCap).toEqual(Array.from({ length: MAX_LONG_QUERIES_IN_FLIGHT }, () => 200))
  }, 300_000)
})
