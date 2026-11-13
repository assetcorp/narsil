import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { POOL_RESTART_DELAY_MS } from '../../../engine/orchestration/constants'
import { waitFor } from '../helpers'
import {
  ARMED_TOKEN,
  distEntry,
  INDEX,
  onNewConnection,
  SETUP_MS,
  type Search,
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

it.skipIf(!existsSync(distEntry))(
  'retires a request thread that hangs inside a request and serves from its replacement within a fixed time',
  async () => {
    const srv = await startServerWithCopies(
      'hung-worker-copies',
      { kind: 'block', waitMs: null },
      {
        workers: {
          silenceBeforeProbeMs: SILENCE_BEFORE_PROBE_MS,
          silenceBeforeRetirementMs: SILENCE_BEFORE_RETIREMENT_MS,
        },
      },
    )
    try {
      await srv.armWorker()
      const searches: Array<Promise<unknown>> = []
      await waitFor(async () => {
        searches.push(
          onNewConnection<Search>(srv.base, `/indexes/${INDEX}/search`, {
            body: { term: ARMED_TOKEN, limit: 1 },
            timeoutMs: REPLACEMENT_BOUND_MS + SETUP_MS,
          }).catch((error: unknown) => error),
        )
        await sleep(SEARCH_SPACING_MS)
        return srv.armedTokenHeld()
      }, SETUP_MS)
      const hungAt = Date.now()

      await waitFor(async () => srv.crashes.length > 0, CRASH_BOUND_MS)
      expect(srv.crashes).toHaveLength(1)
      expect(srv.crashes[0].at - hungAt).toBeLessThanOrEqual(CRASH_BOUND_MS)
      expect(srv.crashes[0].error.message).toMatch(/no answer to any request or probe/)

      await waitFor(
        async () => (await srv.searchOnAThread('ticket'))?.body.count === TICKETS,
        REPLACEMENT_BOUND_MS - (Date.now() - hungAt),
      )
      expect(Date.now() - hungAt).toBeLessThanOrEqual(REPLACEMENT_BOUND_MS)
      expect(srv.crashes).toHaveLength(1)
      expect(srv.server.requestThreadCount).toBe(1)
    } finally {
      await srv.shutDown()
    }
  },
  REPLACEMENT_BOUND_MS + 2 * SETUP_MS,
)
