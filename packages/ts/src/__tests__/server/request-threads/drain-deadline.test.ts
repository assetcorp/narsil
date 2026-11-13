import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { REQUEST_THREAD_DRAIN_DEADLINE_MS } from '../../../server/constants'
import { distEntry, INDEX, onNewConnection, type ServerWithCopies, startServerWithCopies } from './silent-workers'

it.skipIf(!existsSync(distEntry))(
  'answers a request whose admission hook awaits server.close before denying it',
  async () => {
    let srv: ServerWithCopies | undefined
    let closing: Promise<void> | undefined
    srv = await startServerWithCopies(
      'drain-hook-close',
      { kind: 'throw' },
      {
        async onRequest(ctx) {
          if (ctx.headers['x-close-server'] === undefined || srv === undefined) return
          closing = srv.server.close()
          await closing
          return { status: 403, code: 'DENIED', message: 'Access denied' }
        },
      },
    )
    try {
      const started = Date.now()
      const answer = await onNewConnection<{ error: { code: string } }>(srv.base, `/indexes/${INDEX}/count`, {
        headers: { 'x-close-server': '1' },
        timeoutMs: REQUEST_THREAD_DRAIN_DEADLINE_MS + 10_000,
      })
      expect(answer.status).toBe(503)
      expect(answer.connection).toBe('close')
      expect(answer.body.error.code).toBe('WORKER_CRASHED')
      expect(Date.now() - started).toBeLessThan(REQUEST_THREAD_DRAIN_DEADLINE_MS + 10_000)
      await closing
      expect(srv.crashes).toEqual([])
      expect(await srv.engine.countDocuments(INDEX)).toBe(1_200)
    } finally {
      await srv.shutDown()
    }
  },
  60_000,
)
