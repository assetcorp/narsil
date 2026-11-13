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
} from './silent-workers'

it.skipIf(!existsSync(distEntry)).each(['concurrency', 'body memory'] as const)(
  'counts a draining request against the %s limit until it finishes',
  async limit => {
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let entered = false
    const srv = await startServerWithCopies(
      `drain-${limit}`,
      { kind: 'throw' },
      {
        server: {
          limits:
            limit === 'concurrency' ? { maxConcurrentRequests: 1 } : { maxBodyBytesInFlightFraction: Number.MIN_VALUE },
        },
        plugins: [
          {
            name: 'hold-insert',
            async beforeInsert(ctx) {
              if (ctx.docId !== 'held-insert') return
              entered = true
              await held
            },
          },
        ],
      },
    )
    try {
      await srv.armWorker()
      const inserting = onNewConnection<{ id: string }>(srv.base, `/indexes/${INDEX}/documents`, {
        body: { id: 'held-insert', document: { title: 'held ticket' } },
        timeoutMs: SETUP_MS,
      })
      await waitFor(async () => entered)
      await srv.engine.update(INDEX, 'ticket-0', { title: `${ARMED_TOKEN} ticket 0` })
      await waitFor(async () => srv.crashes.length === 1)
      await sleep(100)
      const refused = await onNewConnection(srv.base, `/indexes/${INDEX}/documents`, {
        body: { id: 'refused-insert', document: { title: 'another ticket' } },
        timeoutMs: SETUP_MS,
      })
      release()
      expect((await inserting).status).toBe(201)
      expect(refused.status).toBe(429)
      await waitFor(async () => srv.server.requestThreadCount === 1, SETUP_MS)
      const answer = await onNewConnection<{ count: number }>(srv.base, `/indexes/${INDEX}/count`, {
        timeoutMs: SETUP_MS,
      })
      expect(answer.status).toBe(200)
      expect(answer.body.count).toBe(1_201)
    } finally {
      release()
      await srv.shutDown()
    }
  },
  90_000,
)
