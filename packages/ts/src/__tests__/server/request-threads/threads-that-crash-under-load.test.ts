import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { BroadcastChannel, Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { postJson, scaledOut, startTestServer, type TestServer, waitFor } from '../helpers'

const DOCUMENTS = 1_200
const TAXI_EVERY = 3
const READERS = 6
const ROUNDS_PER_MEANS = 3
const LOAD_BEFORE_THE_CRASH_MS = 300
const LOAD_AFTER_THE_CRASH_MS = 700
const MAIN_BUSY_WHILE_A_THREAD_DIES_MS = 12_000
const REQUEST_TIMEOUT_MS = 30_000
const RECOVERY_TIMEOUT_MS = 60_000
const ROUTING_PROBES = 8
const SAMPLED_DOCUMENTS = 24
const REQUEST_THREADS = 2
const CRASH_CHANNEL = 'narsil-request-thread-crash'
const INDEX = 'fares'
const CRASH_MEANS = ['throw', 'reject', 'exit'] as const
const MEANS_WHILE_MAIN_IS_BUSY = ['throw', 'an exit kept from before serving'] as const

type CrashMeans = (typeof CRASH_MEANS)[number] | (typeof MEANS_WHILE_MAIN_IS_BUSY)[number]

const REPORTED_CRASH: Record<CrashMeans, string> = {
  throw: 'the test threw in this request thread',
  reject: 'the test rejected in this request thread',
  exit: 'Worker exited with code 1',
  'an exit kept from before serving': 'Worker exited with code 1',
}

const EXIT_MEANS = new Set<CrashMeans>(['exit', 'an exit kept from before serving'])

interface FareDocument {
  id: string
  title: string
  route: string
}

type Outcome = { kind: 'answered'; status: number; body: unknown } | { kind: 'dropped' } | { kind: 'hung' }

interface Tally {
  answered: number
  dropped: number
  refused: number
  hung: number
}

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

function fare(i: number): FareDocument {
  return { id: `fare-${i}`, title: i % TAXI_EVERY === 0 ? `taxi fare ${i}` : `bus fare ${i}`, route: `route ${i % 17}` }
}

function crashingBootstrapModule(): string {
  const source = `import { BroadcastChannel, threadId } from 'node:worker_threads'
const channel = new BroadcastChannel(${JSON.stringify(CRASH_CHANNEL)})
const exitFromBeforeServing = process.exit
channel.onmessage = message => {
  if (message.data?.crash !== threadId) return
  if (message.data.means === 'throw') setTimeout(() => { throw new Error('the test threw in this request thread') })
  if (message.data.means === 'reject') setTimeout(() => { Promise.reject(new Error('the test rejected in this request thread')) })
  if (message.data.means === 'exit') process.exit(1)
  if (message.data.means === 'an exit kept from before serving') exitFromBeforeServing.call(process, 1)
}
channel.unref()
channel.postMessage({ threadId })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

async function send(base: string, path: string, body?: unknown): Promise<Outcome> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    return { kind: 'answered', status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') return { kind: 'hung' }
    return { kind: 'dropped' }
  }
}

function searchOnAFreshConnection(base: string, body: unknown): Promise<number> {
  const url = new URL(`/indexes/${INDEX}/search`, base)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method: 'POST', agent: false, headers: { 'content-type': 'application/json', connection: 'close' } },
      incoming => {
        incoming.resume()
        incoming.on('end', () => resolve(incoming.statusCode ?? 0))
        incoming.on('error', reject)
      },
    )
    outgoing.on('error', reject)
    outgoing.end(payload)
  })
}

function blockTheMainThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms)
}

interface OutsideTally {
  counted: number
  healthy: number
  wrong: number
  refused: number
  dropped: number
  hung: number
}

function readFromAnotherThread(base: string): { stop(): Promise<OutsideTally> } {
  const source = `const { request } = require('node:http')
const { parentPort, workerData } = require('node:worker_threads')
const tally = { counted: 0, healthy: 0, wrong: 0, refused: 0, dropped: 0, hung: 0 }
let stopping = false
function read(turn) {
  const counting = turn % 2 === 0
  return new Promise(resolve => {
    const url = counting ? workerData.countUrl : workerData.healthUrl
    const outgoing = request(url, { agent: false, headers: { connection: 'close' }, timeout: workerData.timeoutMs }, incoming => {
      let text = ''
      incoming.setEncoding('utf8')
      incoming.on('data', chunk => { text += chunk })
      incoming.on('end', () => {
        if (incoming.statusCode >= 500) tally.refused += 1
        else if (incoming.statusCode !== 200) tally.wrong += 1
        else if (!counting) tally.healthy += 1
        else if (JSON.parse(text).count === workerData.expected) tally.counted += 1
        else tally.wrong += 1
        resolve()
      })
      incoming.on('error', () => { tally.dropped += 1; resolve() })
    })
    outgoing.on('timeout', () => { tally.hung += 1; outgoing.destroy(); resolve() })
    outgoing.on('error', () => { tally.dropped += 1; resolve() })
    outgoing.end()
  })
}
async function reader(_, index) { for (let turn = index; !stopping; turn += 1) await read(turn) }
const readers = Array.from({ length: workerData.readers }, reader)
parentPort.on('message', async () => { stopping = true; await Promise.all(readers); parentPort.postMessage(tally) })`
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      countUrl: `${base}/indexes/${INDEX}/count`,
      healthUrl: `${base}/health`,
      expected: DOCUMENTS,
      readers: READERS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  })
  return {
    stop: async () => {
      const tally = new Promise<OutsideTally>(resolve => worker.once('message', resolve))
      worker.postMessage('stop')
      const result = await tally
      await worker.terminate()
      return result
    },
  }
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe.skipIf(!built)('request threads that crash under HTTP load', () => {
  let srv: TestServer
  let channel: BroadcastChannel
  const announced: number[] = []
  const crashes: Error[] = []
  let mainQueries = 0

  beforeEach(async () => {
    announced.length = 0
    crashes.length = 0
    channel = new BroadcastChannel(CRASH_CHANNEL)
    channel.onmessage = (message: unknown) => {
      const threadId = (message as { data?: { threadId?: unknown } }).data?.threadId
      if (typeof threadId === 'number') announced.push(threadId)
    }
    srv = await startTestServer(
      undefined,
      { workers: { count: REQUEST_THREADS, bootstrapModule: crashingBootstrapModule() } },
      async engine => {
        engine.on('workerCrash', ({ error }) => crashes.push(error))
        const query = engine.query.bind(engine)
        engine.query = (indexName, params) => {
          mainQueries += 1
          return query(indexName, params)
        }
      },
    )
  })

  afterEach(async () => {
    channel.close()
    await srv.stop()
  })

  async function everyThreadAnswersOnItsOwnCopy(): Promise<boolean> {
    const before = mainQueries
    const statuses = await Promise.all(
      Array.from({ length: ROUTING_PROBES }, () => searchOnAFreshConnection(srv.base, { term: 'taxi', limit: 1 })),
    )
    return statuses.every(status => status === 200) && mainQueries === before
  }

  async function threadsServeEveryRead(): Promise<void> {
    await waitFor(async () => srv.server.requestThreadCount === REQUEST_THREADS, RECOVERY_TIMEOUT_MS)
    await waitFor(() => scaledOut(srv.engine, INDEX), RECOVERY_TIMEOUT_MS)
    await waitFor(everyThreadAnswersOnItsOwnCopy, RECOVERY_TIMEOUT_MS)
  }

  async function loadFares(): Promise<FareDocument[]> {
    const fares = Array.from({ length: DOCUMENTS }, (_, i) => fare(i))
    const created = await postJson(srv.base, '/indexes', {
      name: INDEX,
      config: { schema: { title: 'string', route: 'string' } },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const written = await postJson<{ failed: unknown[] }>(srv.base, `/indexes/${INDEX}/documents/_batch`, {
      action: 'insert',
      documents: fares,
      options: { wait: true },
    })
    expect(written.status, JSON.stringify(written.body)).toBe(200)
    expect(written.body.failed).toEqual([])
    await threadsServeEveryRead()
    return fares
  }

  function readersOf(fares: FareDocument[], tally: Tally): (stop: { done: boolean }) => Promise<void> {
    const taxiIds = fares
      .filter(document => document.title.startsWith('taxi'))
      .map(document => document.id)
      .sort()
    const sample = fares.filter((_, i) => i % Math.floor(DOCUMENTS / SAMPLED_DOCUMENTS) === 0)

    function settle(outcome: Outcome, what: string, check: (body: unknown) => void): void {
      if (outcome.kind !== 'answered') {
        tally[outcome.kind] += 1
        return
      }
      if (outcome.status >= 500) {
        tally.refused += 1
        return
      }
      expect(outcome.status, `${what}: ${JSON.stringify(outcome.body)}`).toBe(200)
      check(outcome.body)
      tally.answered += 1
    }

    const checks: Array<(turn: number) => Promise<void>> = [
      async () => {
        const outcome = await send(srv.base, `/indexes/${INDEX}/search`, { term: 'taxi', limit: DOCUMENTS })
        settle(outcome, 'a search for taxi', body => {
          const answer = body as { count: number; hits: Array<{ id: string }> }
          expect(answer.count, 'the taxi count').toBe(taxiIds.length)
          expect(answer.hits.map(hit => hit.id).sort(), 'the taxi hits').toEqual(taxiIds)
        })
      },
      async turn => {
        const expected = sample[turn % sample.length]
        const outcome = await send(srv.base, `/indexes/${INDEX}/documents/${expected.id}`)
        settle(outcome, `a read of ${expected.id}`, body => expect(body).toEqual({ document: expected }))
      },
      async () => {
        const outcome = await send(srv.base, `/indexes/${INDEX}/count`)
        settle(outcome, 'a count', body => expect((body as { count: number }).count).toBe(DOCUMENTS))
      },
    ]

    return stop => {
      const reading = readUntil(stop)
      reading.catch(() => undefined)
      return reading
    }

    async function readUntil(stop: { done: boolean }): Promise<void> {
      const failures: unknown[] = []
      await Promise.all(
        Array.from({ length: READERS }, async (_, reader) => {
          try {
            for (let turn = reader; !stop.done; turn += 1) await checks[turn % checks.length](turn)
          } catch (err) {
            failures.push(err)
            stop.done = true
          }
        }),
      )
      if (failures.length > 0) throw failures[0]
    }
  }

  function nextVictim(crashed: Set<number>): number {
    const victim = announced.filter(threadId => !crashed.has(threadId)).at(-1)
    if (victim === undefined) throw new Error('no request thread announced itself')
    crashed.add(victim)
    return victim
  }

  async function expectServingAfterwards(tally: Tally): Promise<void> {
    expect(tally.hung, `requests that never ended: ${JSON.stringify(tally)}`).toBe(0)
    expect(tally.answered).toBeGreaterThan(0)
    const health = await send(srv.base, '/health')
    expect(health.kind === 'answered' && health.status).toBe(200)
  }

  function expectReportedCrashes(means: CrashMeans, rounds: number): void {
    expect(crashes.map(error => error.message)).toEqual(Array.from({ length: rounds }, () => REPORTED_CRASH[means]))
    if (EXIT_MEANS.has(means)) return
    for (const error of crashes) expect(error.stack).toContain('data:text/javascript')
  }

  it.each(
    CRASH_MEANS,
  )('keeps the process serving and replaces a thread that crashes by %s, round after round', async (means: CrashMeans) => {
    const fares = await loadFares()
    const tally: Tally = { answered: 0, dropped: 0, refused: 0, hung: 0 }
    const read = readersOf(fares, tally)
    const crashed = new Set<number>()
    for (let round = 0; round < ROUNDS_PER_MEANS; round++) {
      const victim = nextVictim(crashed)
      const seenBefore = announced.length
      const stop = { done: false }
      const reading = read(stop)
      await pause(LOAD_BEFORE_THE_CRASH_MS)
      channel.postMessage({ crash: victim, means })
      await pause(LOAD_AFTER_THE_CRASH_MS)
      await waitFor(async () => announced.length > seenBefore, RECOVERY_TIMEOUT_MS)
      await threadsServeEveryRead()
      stop.done = true
      await reading
    }
    await expectServingAfterwards(tally)
    expectReportedCrashes(means, ROUNDS_PER_MEANS)
  }, 600_000)

  it.each(
    MEANS_WHILE_MAIN_IS_BUSY,
  )('keeps the process serving when a thread crashes by %s while the main thread is busy for 12 seconds', async (means: CrashMeans) => {
    const fares = await loadFares()
    const tally: Tally = { answered: 0, dropped: 0, refused: 0, hung: 0 }
    const read = readersOf(fares, tally)
    const victim = nextVictim(new Set())
    const seenBefore = announced.length
    const stop = { done: false }
    const reading = read(stop)
    const outside = readFromAnotherThread(srv.base)
    await pause(LOAD_BEFORE_THE_CRASH_MS)
    channel.postMessage({ crash: victim, means })
    blockTheMainThread(MAIN_BUSY_WHILE_A_THREAD_DIES_MS)
    await pause(LOAD_AFTER_THE_CRASH_MS)
    await waitFor(async () => announced.length > seenBefore, RECOVERY_TIMEOUT_MS)
    await threadsServeEveryRead()
    stop.done = true
    await reading
    const outsideTally = await outside.stop()
    expect(outsideTally.wrong, JSON.stringify(outsideTally)).toBe(0)
    expect(outsideTally.hung, JSON.stringify(outsideTally)).toBe(0)
    expect(outsideTally.counted).toBeGreaterThan(0)
    expect(outsideTally.healthy).toBeGreaterThan(0)
    await expectServingAfterwards(tally)
    expectReportedCrashes(means, 1)
  }, 600_000)
})
