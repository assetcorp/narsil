import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { POOL_RESTART_DELAY_MS } from '../../../engine/orchestration/constants'
import { WORKER_SILENCE_BEFORE_DEATH_MS, WORKER_SILENCE_BEFORE_PROBE_MS } from '../../../workers/constants'
import { postJson, waitFor } from '../helpers'
import { ARMED_TOKEN, distEntry, INDEX, SETUP_MS, type Search, startServerWithCopies, TICKETS } from './silent-workers'

const SCHEDULING_SLACK_MS = 15_000
const CRASH_BOUND_MS = WORKER_SILENCE_BEFORE_DEATH_MS + SCHEDULING_SLACK_MS
const REPLACEMENT_BOUND_MS =
  WORKER_SILENCE_BEFORE_DEATH_MS + WORKER_SILENCE_BEFORE_PROBE_MS + POOL_RESTART_DELAY_MS + SETUP_MS

it.skipIf(!existsSync(distEntry))(
  'retires a worker that answers no probe and serves from its replacement within a fixed time',
  async () => {
    const srv = await startServerWithCopies('hung-worker-copies', { kind: 'block', waitMs: null })
    try {
      await srv.armWorker()
      await srv.engine.update(INDEX, 'ticket-0', { title: `${ARMED_TOKEN} ticket 0` })
      await srv.armedTokenReached()
      const hungAt = Date.now()

      await waitFor(async () => srv.crashes.length > 0, CRASH_BOUND_MS)
      expect(srv.crashes).toHaveLength(1)
      expect(srv.crashes[0].at - hungAt).toBeLessThanOrEqual(CRASH_BOUND_MS)
      expect(srv.crashes[0].error.message).toMatch(/no answer to any request or probe/)

      await waitFor(
        async () => {
          const answer = await srv.searchOnAThread(ARMED_TOKEN)
          return answer?.body.hits[0]?.id === 'ticket-0'
        },
        REPLACEMENT_BOUND_MS - (Date.now() - hungAt),
      )
      expect(Date.now() - hungAt).toBeLessThanOrEqual(REPLACEMENT_BOUND_MS)

      const answer = await postJson<Search>(srv.base, `/indexes/${INDEX}/search`, { term: 'ticket', limit: 1 })
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect(answer.body.count).toBe(TICKETS)
      expect(srv.crashes).toHaveLength(1)
      expect(srv.server.requestThreadCount).toBe(1)
    } finally {
      await srv.shutDown()
    }
  },
  REPLACEMENT_BOUND_MS + 2 * SETUP_MS,
)
