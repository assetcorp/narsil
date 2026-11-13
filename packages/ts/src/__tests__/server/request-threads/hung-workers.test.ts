import { existsSync } from 'node:fs'
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
const NO_REPLACEMENT_WINDOW_MS = 3 * (SILENCE_BEFORE_PROBE_MS + POOL_RESTART_DELAY_MS)
const NO_REPLACEMENT_CHECK_SPACING_MS = 500
const SEARCH_SPACING_MS = 50
const FRESH_CONNECTIONS = 24
const FRESH_CONNECTION_TIMEOUT_MS = 10_000
const TEST_TIMEOUT_MS = 2 * REPLACEMENT_BOUND_MS + 2 * SETUP_MS

function startHangingServer(maxThreadsLeftRunning?: number): Promise<ServerWithCopies> {
  return startServerWithCopies(
    'hung-worker-copies',
    { kind: 'block', waitMs: null },
    {
      workers: {
        silenceBeforeProbeMs: SILENCE_BEFORE_PROBE_MS,
        silenceBeforeRetirementMs: SILENCE_BEFORE_RETIREMENT_MS,
        maxThreadsLeftRunning,
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
          async () => (await srv.searchOnAThread('ticket'))?.body.count === TICKETS,
          REPLACEMENT_BOUND_MS - (Date.now() - hungAt),
        )
        expect(Date.now() - hungAt).toBeLessThanOrEqual(REPLACEMENT_BOUND_MS)
        await expectEveryFreshConnectionAnswered(srv)
        expect(srv.crashes).toHaveLength(1)
        expect(srv.server.requestThreadCount).toBe(1)
      } finally {
        await srv.shutDown()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'gains no replacement while more threads than the limit run in the background, and gains one once the thread exits',
    async () => {
      const srv = await startHangingServer(0)
      try {
        await hangTheThreadAndWaitForItsRetirement(srv)
        const windowEnds = Date.now() + NO_REPLACEMENT_WINDOW_MS
        while (Date.now() < windowEnds) {
          expect(srv.server.requestThreadCount).toBe(0)
          await expectEveryFreshConnectionAnswered(srv)
          await sleep(NO_REPLACEMENT_CHECK_SPACING_MS)
        }
        expect(srv.server.requestThreadCount).toBe(0)

        srv.releaseWorker()
        const releasedAt = Date.now()
        await waitFor(async () => (await srv.searchOnAThread('ticket'))?.body.count === TICKETS, REPLACEMENT_BOUND_MS)
        expect(Date.now() - releasedAt).toBeLessThanOrEqual(REPLACEMENT_BOUND_MS)
        await expectEveryFreshConnectionAnswered(srv)
        expect(srv.crashes).toHaveLength(1)
        expect(srv.server.requestThreadCount).toBe(1)
      } finally {
        await srv.shutDown()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
