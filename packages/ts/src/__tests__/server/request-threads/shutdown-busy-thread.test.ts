import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { WORKER_SILENCE_BEFORE_PROBE_MS } from '../../../workers/constants'
import {
  ARMED_TOKEN,
  distEntry,
  INDEX,
  onNewConnection,
  SETUP_MS,
  type Search,
  sleep,
  startServerWithCopies,
} from './silent-workers'

it.skipIf(!existsSync(distEntry))(
  'lets a busy request thread finish during engine shutdown past the first probe',
  async () => {
    const srv = await startServerWithCopies('shutdown-busy-thread', { kind: 'block', waitMs: SETUP_MS })
    try {
      await srv.armWorker()
      const response = onNewConnection<Search>(srv.base, `/indexes/${INDEX}/search`, {
        body: { term: ARMED_TOKEN },
        timeoutMs: SETUP_MS,
      }).then(
        answer => ({ answer }),
        error => ({ error }),
      )
      await srv.armedTokenReached()
      const closing = srv.engine.shutdown()
      await sleep(WORKER_SILENCE_BEFORE_PROBE_MS + 2_000)
      srv.releaseWorker()
      const outcome = await response
      expect(outcome).not.toHaveProperty('error')
      if ('answer' in outcome) {
        expect(outcome.answer.status).toBe(200)
        expect(outcome.answer.body.count).toBe(0)
      }
      await closing
      expect(srv.crashes).toEqual([])
    } finally {
      await srv.shutDown()
    }
  },
  90_000,
)
