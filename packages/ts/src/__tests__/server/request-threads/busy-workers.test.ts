import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MAX_PENDING_REPLICATION_DOCUMENTS } from '../../../engine/orchestration/constants'
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

const BATCH = 50
const SILENCE_BEFORE_PROBE_MS = 1_000
const BUSY_MS = 12 * SILENCE_BEFORE_PROBE_MS
const SILENCE_BEFORE_RETIREMENT_MS = 2 * BUSY_MS
const STALL_MS = 3_000
const SEARCHES_WHILE_BUSY = 8

it.skipIf(!existsSync(distEntry))(
  'keeps a worker that stays silent past many probes but short of retirement, answers every request, and caps the replication it queues',
  async () => {
    const srv = await startServerWithCopies(
      'busy-worker-copies',
      { kind: 'block', waitMs: BUSY_MS + SETUP_MS },
      {
        workers: {
          silenceBeforeProbeMs: SILENCE_BEFORE_PROBE_MS,
          silenceBeforeRetirementMs: SILENCE_BEFORE_RETIREMENT_MS,
        },
      },
    )
    try {
      await srv.armWorker()
      await srv.engine.update(INDEX, 'ticket-0', { title: `${ARMED_TOKEN} ticket 0` })
      await srv.armedTokenReached()
      const blockedAt = Date.now()

      const searches = Array.from({ length: SEARCHES_WHILE_BUSY }, () =>
        onNewConnection<Search>(srv.base, `/indexes/${INDEX}/search`, {
          body: { term: 'ticket', limit: 1 },
          timeoutMs: BUSY_MS + SETUP_MS,
        }),
      )

      let acknowledged = 0
      let stalledWrite: Promise<unknown> | null = null
      while (acknowledged <= MAX_PENDING_REPLICATION_DOCUMENTS) {
        const first = acknowledged
        const write = srv.engine.insertBatch(
          INDEX,
          Array.from({ length: BATCH }, (_, i) => ({ id: `load-${first + i}`, title: `load ${first + i}` })),
        )
        const outcome = await Promise.race([write.then(() => 'written'), sleep(STALL_MS).then(() => 'stalled')])
        if (outcome === 'stalled') {
          stalledWrite = write
          break
        }
        acknowledged += BATCH
      }
      expect(stalledWrite).not.toBeNull()
      expect(acknowledged).toBeLessThanOrEqual(MAX_PENDING_REPLICATION_DOCUMENTS)
      expect(acknowledged).toBeGreaterThanOrEqual(MAX_PENDING_REPLICATION_DOCUMENTS - 2 * BATCH)

      await sleep(blockedAt + BUSY_MS - Date.now())
      expect(srv.crashes).toEqual([])
      srv.releaseWorker()

      for (const answer of await Promise.all(searches)) {
        expect(answer.status, JSON.stringify(answer.body)).toBe(200)
        expect(answer.body.count).toBe(TICKETS)
      }
      await stalledWrite
      const loaded = acknowledged + BATCH
      await srv.engine.insertBatch(INDEX, [{ id: 'last-ticket', title: 'ticket last' }], { wait: true })

      await waitFor(async () => (await srv.searchOnAThread('load'))?.body.count === loaded, SETUP_MS)
      await waitFor(async () => (await srv.searchOnAThread(ARMED_TOKEN))?.body.hits[0]?.id === 'ticket-0', SETUP_MS)
      expect(srv.crashes).toEqual([])
      expect(srv.server.requestThreadCount).toBe(1)
    } finally {
      await srv.shutDown()
    }
  },
  BUSY_MS + 3 * SETUP_MS,
)
