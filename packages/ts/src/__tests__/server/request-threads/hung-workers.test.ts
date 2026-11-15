import { existsSync } from 'node:fs'
import { Agent, request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { POOL_RESTART_DELAY_MS } from '../../../engine/orchestration/constants'
import { waitFor } from '../helpers'
import {
  ARMED_TOKEN,
  distEntry,
  INDEX,
  onNewConnection,
  SETUP_MS,
  type Search,
  type ServerWithCopies,
  sleep,
  startServerWithCopies,
  TICKETS,
} from './silent-workers'

const SILENCE_BEFORE_PROBE_MS = 1_000
const SILENCE_BEFORE_RETIREMENT_MS = 4_000
const SCHEDULING_SLACK_MS = 5_000
const COPY_LOAD_SLACK_MS = 20_000
const CRASH_BOUND_MS = SILENCE_BEFORE_RETIREMENT_MS + SILENCE_BEFORE_PROBE_MS + SCHEDULING_SLACK_MS
const REPLACEMENT_BOUND_MS = CRASH_BOUND_MS + SILENCE_BEFORE_PROBE_MS + POOL_RESTART_DELAY_MS + COPY_LOAD_SLACK_MS
const SEARCH_SPACING_MS = 50
const FRESH_CONNECTIONS = 24
const FRESH_CONNECTION_TIMEOUT_MS = 10_000
const TEST_TIMEOUT_MS = 2 * REPLACEMENT_BOUND_MS + 2 * SETUP_MS
const KEPT_ALIVE_READERS = 8
const READS_AFTER_RECOVERY = 3

type CountOutcome = { status: number; connection: string | undefined; count: unknown } | { failed: string }

function countOnKeptAliveConnection(base: string, agent: Agent): Promise<CountOutcome> {
  return new Promise(resolve => {
    const outgoing = request(
      new URL(`/indexes/${INDEX}/count`, base),
      { agent, timeout: TEST_TIMEOUT_MS },
      incoming => {
        let text = ''
        incoming.setEncoding('utf8')
        incoming.on('data', chunk => {
          text += chunk
        })
        incoming.on('end', () => {
          const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined
          resolve({
            status: incoming.statusCode ?? 0,
            connection: incoming.headers.connection,
            count: (parsed as { count?: unknown } | undefined)?.count,
          })
        })
        incoming.on('error', error => resolve({ failed: error.message }))
      },
    )
    outgoing.on('timeout', () => outgoing.destroy(new Error('the count never answered')))
    outgoing.on('error', error => resolve({ failed: error.message }))
    outgoing.end()
  })
}

function readOnKeptAliveConnections(base: string): {
  outcomes: CountOutcome[]
  readsAfter(mark: number): boolean
  stop(): Promise<void>
} {
  const agent = new Agent({ keepAlive: true, maxSockets: KEPT_ALIVE_READERS })
  const outcomes: CountOutcome[] = []
  const finishedAt: number[][] = Array.from({ length: KEPT_ALIVE_READERS }, () => [])
  let stopping = false
  const readers = Array.from({ length: KEPT_ALIVE_READERS }, async (_, reader) => {
    while (!stopping) {
      outcomes.push(await countOnKeptAliveConnection(base, agent))
      finishedAt[reader].push(Date.now())
    }
  })
  return {
    outcomes,
    readsAfter: mark => finishedAt.every(finished => finished.filter(at => at > mark).length >= READS_AFTER_RECOVERY),
    async stop() {
      stopping = true
      await Promise.all(readers)
      agent.destroy()
    },
  }
}

function startHangingServer(): Promise<ServerWithCopies> {
  return startServerWithCopies(
    'hung-worker-copies',
    { kind: 'block', waitMs: null },
    {
      workers: {
        silenceBeforeProbeMs: SILENCE_BEFORE_PROBE_MS,
        silenceBeforeRetirementMs: SILENCE_BEFORE_RETIREMENT_MS,
      },
    },
  )
}

async function hangTheThreadAndWaitForItsRetirement(srv: ServerWithCopies): Promise<number> {
  await srv.armWorker()
  await waitFor(async () => {
    void onNewConnection<Search>(srv.base, `/indexes/${INDEX}/search`, {
      body: { term: ARMED_TOKEN, limit: 1 },
      timeoutMs: TEST_TIMEOUT_MS,
    }).catch((error: unknown) => error)
    await sleep(SEARCH_SPACING_MS)
    return srv.armedTokenHeld()
  }, SETUP_MS)
  const hungAt = Date.now()
  await waitFor(async () => srv.crashes.length > 0, CRASH_BOUND_MS)
  expect(srv.crashes).toHaveLength(1)
  expect(srv.crashes[0].at - hungAt).toBeLessThanOrEqual(CRASH_BOUND_MS)
  expect(srv.crashes[0].error.message).toMatch(/no answer to any request or probe/)
  return hungAt
}

async function expectEveryFreshConnectionAnswered(srv: ServerWithCopies): Promise<void> {
  const answers = await Promise.all(
    Array.from({ length: FRESH_CONNECTIONS }, () =>
      onNewConnection<{ count: number }>(srv.base, `/indexes/${INDEX}/count`, {
        timeoutMs: FRESH_CONNECTION_TIMEOUT_MS,
      }),
    ),
  )
  for (const answer of answers) {
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body).toEqual({ count: TICKETS })
  }
}

describe.skipIf(!existsSync(distEntry))('a request thread that hangs inside a request', () => {
  it(
    'is retired, takes no new connection, and is replaced within a fixed time',
    async () => {
      const srv = await startHangingServer()
      try {
        const hungAt = await hangTheThreadAndWaitForItsRetirement(srv)
        await expectEveryFreshConnectionAnswered(srv)

        await waitFor(
          async () => srv.server.requestThreadCount === 1 && (await srv.search('ticket')).body.count === TICKETS,
          REPLACEMENT_BOUND_MS - (Date.now() - hungAt),
        )
        expect(Date.now() - hungAt).toBeLessThanOrEqual(REPLACEMENT_BOUND_MS)
        await expectEveryFreshConnectionAnswered(srv)
        expect(srv.crashes).toHaveLength(1)
      } finally {
        await srv.shutDown()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'answers every request on its kept-alive connections once it recovers from the hang',
    async () => {
      const srv = await startHangingServer()
      const readers = readOnKeptAliveConnections(srv.base)
      try {
        await waitFor(async () => readers.readsAfter(0), SETUP_MS)
        await hangTheThreadAndWaitForItsRetirement(srv)
        const releasedAt = Date.now()
        srv.releaseWorker()
        await waitFor(async () => readers.readsAfter(releasedAt), SETUP_MS)
        await readers.stop()
        const outcomes = readers.outcomes
        const wrong = outcomes.filter(outcome => !('status' in outcome) || outcome.status !== 200)
        expect(wrong, JSON.stringify(wrong.slice(0, 5))).toEqual([])
        for (const outcome of outcomes) expect(outcome).toMatchObject({ count: TICKETS })
        const closedByTheLeavingThread = outcomes.filter(
          outcome =>
            'connection' in outcome && (outcome.connection ?? '').split(',').some(token => token.trim() === 'close'),
        )
        expect(closedByTheLeavingThread.length).toBeGreaterThan(0)
      } finally {
        await readers.stop()
        await srv.shutDown()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
