import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { waitFor } from '../helpers'
import {
  type Answer,
  ARMED_TOKEN,
  distEntry,
  INDEX,
  onNewConnection,
  SETUP_MS,
  type ServerWithCopies,
  sleep,
  startServerWithCopies,
  TICKETS,
} from './silent-workers'

const HELD_REQUESTS = 12
const FRESH_REQUESTS = 8
const HELD_HEADER = 'x-held-by-the-test'
const REQUEST_TIMEOUT_MS = 60_000
const AFTER_RETIREMENT_MS = 1_000

describe.skipIf(!existsSync(distEntry))('a request thread that leaves while requests wait on it', () => {
  let srv: ServerWithCopies
  let releaseHeld: () => void = () => undefined
  let heldArrivals = 0

  beforeEach(async () => {
    heldArrivals = 0
    const held = new Promise<void>(resolve => {
      releaseHeld = resolve
    })
    srv = await startServerWithCopies(
      'draining-thread-copies',
      { kind: 'throw' },
      {
        server: {
          onRequest: async ctx => {
            if (ctx.headers[HELD_HEADER] === undefined) return undefined
            heldArrivals += 1
            await held
            return undefined
          },
        },
      },
    )
  })

  afterEach(async () => {
    releaseHeld()
    await srv.shutDown()
  })

  function count(headers: Record<string, string>): Promise<Answer<{ count: number }>> {
    return onNewConnection<{ count: number }>(srv.base, `/indexes/${INDEX}/count`, {
      headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  }

  async function holdRequests(): Promise<Array<Promise<Answer<{ count: number }>>>> {
    const answers = Array.from({ length: HELD_REQUESTS }, () => count({ [HELD_HEADER]: '1' }))
    await waitFor(async () => heldArrivals === HELD_REQUESTS, SETUP_MS)
    return answers
  }

  function expectEveryCount(settled: Array<Answer<{ count: number }>>): void {
    for (const answer of settled) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect(answer.body).toEqual({ count: TICKETS })
    }
  }

  it('answers every waiting request when the pool retires the thread, then serves from its replacement', async () => {
    await srv.armWorker()
    const answers = await holdRequests()
    await srv.engine.update(INDEX, 'ticket-0', { title: `${ARMED_TOKEN} ticket 0` })
    await waitFor(async () => srv.crashes.length > 0, SETUP_MS)
    await sleep(AFTER_RETIREMENT_MS)
    releaseHeld()

    expectEveryCount(await Promise.all(answers))
    expect(srv.crashes).toHaveLength(1)
    await waitFor(async () => srv.server.requestThreadCount === 1, SETUP_MS)
    expectEveryCount(await Promise.all(Array.from({ length: FRESH_REQUESTS }, () => count({}))))
  }, 180_000)

  it('answers every waiting request when the server closes', async () => {
    const answers = await holdRequests()
    const closing = srv.server.close()
    await sleep(AFTER_RETIREMENT_MS)
    releaseHeld()

    expectEveryCount(await Promise.all(answers))
    await closing
    expect(srv.crashes).toEqual([])
  }, 180_000)
})
