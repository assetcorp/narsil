import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { waitFor } from '../helpers'
import {
  ARMED_TOKEN,
  distEntry,
  INDEX,
  onNewConnection,
  SETUP_MS,
  sleep,
  startServerWithCopies,
  TICKETS,
} from './silent-workers'

const FAILED_TOKEN = 'rejectcopy'
const SILENCE_BEFORE_PROBE_MS = 1_000
const SILENCE_BEFORE_RETIREMENT_MS = 4_000
const SEARCH_SPACING_MS = 50

it.skipIf(!existsSync(distEntry)).each(['concurrency', 'body memory'] as const)(
  'counts an abandoned request against the %s limit after its replacement retires',
  async limit => {
    const srv = await startServerWithCopies(
      `abandoned-${limit}`,
      { kind: 'block', waitMs: null },
      {
        failOnToken: FAILED_TOKEN,
        workers: {
          silenceBeforeProbeMs: SILENCE_BEFORE_PROBE_MS,
          silenceBeforeRetirementMs: SILENCE_BEFORE_RETIREMENT_MS,
        },
        server: {
          limits:
            limit === 'concurrency' ? { maxConcurrentRequests: 1 } : { maxBodyBytesInFlightFraction: Number.MIN_VALUE },
        },
      },
    )
    const searching: Array<Promise<unknown>> = []
    const search = (term: string) =>
      onNewConnection<{ count: number }>(srv.base, `/indexes/${INDEX}/search`, {
        body: { term, limit: 1 },
        timeoutMs: SETUP_MS,
      })
    try {
      await srv.armWorker()
      await waitFor(async () => {
        searching.push(search(ARMED_TOKEN).catch((error: unknown) => error))
        await sleep(SEARCH_SPACING_MS)
        return srv.armedTokenHeld()
      }, SETUP_MS)
      await waitFor(async () => srv.crashes.length === 1 && srv.server.requestThreadCount === 1, SETUP_MS)
      expect((await search('ticket')).status).toBe(429)

      await srv.engine.update(INDEX, 'ticket-0', { title: FAILED_TOKEN })
      await waitFor(async () => srv.crashes.length === 2 && srv.server.requestThreadCount === 1, SETUP_MS)
      expect((await search('ticket')).status).toBe(429)

      srv.releaseWorker()
      await Promise.all(searching)
      await waitFor(async () => (await search('ticket')).body.count === TICKETS - 1, SETUP_MS)
      expect(srv.crashes).toHaveLength(2)
    } finally {
      await srv.shutDown()
      await Promise.all(searching)
    }
  },
  2 * SETUP_MS,
)
