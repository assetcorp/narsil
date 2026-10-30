import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { BroadcastChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LONG_QUERY_THREADS } from '../../../engine/orchestration/constants'
import { postJson, scaledOut, startTestServer, type TestServer, waitFor } from '../helpers'

const DOCUMENTS = 1_200
const HELD_REQUESTS = 8
const REQUEST_THREADS = 2
const RECOVERY_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000
const CRASH_CHANNEL = 'narsil-request-thread-crash-mid-request'
const HELD_HEADER = 'x-held-by-the-test'
const INDEX = 'tickets'
const THROWN_MESSAGE = 'the test threw while requests were in flight'

interface Answer {
  status: number
  connection: string | undefined
  body: unknown
  settledWhileHeld: boolean
}

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

function crashingBootstrapModule(): string {
  const source = `import { BroadcastChannel, threadId, workerData } from 'node:worker_threads'
const channel = new BroadcastChannel(${JSON.stringify(CRASH_CHANNEL)})
channel.onmessage = message => {
  if (message.data?.crash === threadId) setTimeout(() => { throw new Error(${JSON.stringify(THROWN_MESSAGE)}) })
}
channel.unref()
channel.postMessage({ threadId, workerId: workerData?.workerId })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

describe.skipIf(!built)('a request thread that crashes while requests wait on it', () => {
  let srv: TestServer
  let channel: BroadcastChannel
  let releaseHeld: () => void = () => undefined
  let holding = true
  let heldArrivals = 0
  const announced: Array<{ threadId: number; workerId: number }> = []
  const crashes: Error[] = []

  beforeEach(async () => {
    announced.length = 0
    crashes.length = 0
    heldArrivals = 0
    holding = true
    const held = new Promise<void>(resolve => {
      releaseHeld = () => {
        holding = false
        resolve()
      }
    })
    channel = new BroadcastChannel(CRASH_CHANNEL)
    channel.onmessage = (message: unknown) => {
      const data = (message as { data?: { threadId?: unknown; workerId?: unknown } }).data
      if (typeof data?.threadId === 'number' && typeof data.workerId === 'number') {
        announced.push({ threadId: data.threadId, workerId: data.workerId })
      }
    }
    srv = await startTestServer(
      {
        onRequest: async ctx => {
          if (ctx.headers[HELD_HEADER] === undefined) return undefined
          heldArrivals += 1
          await held
          return undefined
        },
      },
      { workers: { count: REQUEST_THREADS, bootstrapModule: crashingBootstrapModule() } },
      async engine => {
        engine.on('workerCrash', ({ error }) => crashes.push(error))
      },
    )
  })

  afterEach(async () => {
    releaseHeld()
    channel.close()
    await srv.stop()
  })

  function countWhileHeld(): Promise<Answer> {
    const url = new URL(`/indexes/${INDEX}/count`, srv.base)
    return new Promise((resolve, reject) => {
      const outgoing = request(
        url,
        { agent: false, headers: { [HELD_HEADER]: '1' }, timeout: REQUEST_TIMEOUT_MS },
        incoming => {
          let text = ''
          incoming.setEncoding('utf8')
          incoming.on('data', chunk => {
            text += chunk
          })
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              connection: incoming.headers.connection,
              body: text.length > 0 ? JSON.parse(text) : undefined,
              settledWhileHeld: holding,
            }),
          )
          incoming.on('error', reject)
        },
      )
      outgoing.on('timeout', () => outgoing.destroy(new Error('the held request never ended')))
      outgoing.on('error', reject)
      outgoing.end()
    })
  }

  it('answers every request already waiting on the failed thread with 503 and a closed connection', async () => {
    const created = await postJson(srv.base, '/indexes', { name: INDEX, config: { schema: { title: 'string' } } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const written = await postJson<{ failed: unknown[] }>(srv.base, `/indexes/${INDEX}/documents/_batch`, {
      action: 'insert',
      documents: Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `ticket-${i}`, title: `ticket ${i}` })),
      options: { wait: true },
    })
    expect(written.status, JSON.stringify(written.body)).toBe(200)
    expect(written.body.failed).toEqual([])
    await waitFor(async () => srv.server.requestThreadCount === REQUEST_THREADS, RECOVERY_TIMEOUT_MS)
    await waitFor(() => scaledOut(srv.engine, INDEX), RECOVERY_TIMEOUT_MS)
    await waitFor(async () => announced.length === REQUEST_THREADS + LONG_QUERY_THREADS, RECOVERY_TIMEOUT_MS)

    const answers = Array.from({ length: HELD_REQUESTS }, () => countWhileHeld())
    await waitFor(async () => heldArrivals === HELD_REQUESTS, RECOVERY_TIMEOUT_MS)
    const seenBefore = announced.length
    channel.postMessage({ crash: announced.find(entry => entry.workerId === 0)?.threadId })
    await waitFor(async () => announced.length > seenBefore, RECOVERY_TIMEOUT_MS)
    releaseHeld()
    const settled = await Promise.all(answers)

    const refused = settled.filter(answer => answer.status === 503)
    const counted = settled.filter(answer => answer.status === 200)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.length + counted.length, JSON.stringify(settled)).toBe(HELD_REQUESTS)
    for (const answer of refused) {
      expect(answer.settledWhileHeld).toBe(true)
      expect(answer.connection).toBe('close')
      expect(answer.body).toMatchObject({ error: { code: 'WORKER_CRASHED' } })
    }
    for (const answer of counted) expect(answer.body).toEqual({ count: DOCUMENTS })
    expect(crashes.map(error => error.message)).toEqual([THROWN_MESSAGE])
    expect(crashes[0]?.stack).toContain('data:text/javascript')
  }, 300_000)
})
