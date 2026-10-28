import { existsSync } from 'node:fs'
import { BroadcastChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getJson, type HttpResult, postJson, startTestServer, type TestServer, waitFor } from '../helpers'

const BASE_DOCUMENTS = 900
const DOCUMENTS_THAT_CROSS_THE_COPY_THRESHOLD = 300
const TAXI_EVERY = 3
const WORDS_PER_BODY = 300
const VOCABULARY_SIZE = 40
const READERS = 6
const RETRIES_PER_READ = 5
const COPY_IDLE_TIMEOUT_MS = 1_000
const COPY_LOAD_TIMEOUT_MS = 120_000
const ROUTING_PROBES = 8
const SAMPLED_DOCUMENTS = 16
const INDEX = 'notes'
const KILL_CHANNEL = 'narsil-copy-load-kill'

interface NoteDocument {
  id: string
  title: string
  body: string
}

interface ThreadAnnouncement {
  threadId: number
}

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

function bootstrapModule(): string {
  const source = `import { BroadcastChannel, threadId } from 'node:worker_threads'
const channel = new BroadcastChannel(${JSON.stringify(KILL_CHANNEL)})
channel.onmessage = message => { if (message.data?.kill === threadId) setTimeout(() => { throw new Error('the test ended this worker') }) }
channel.unref()
channel.postMessage({ threadId })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

function note(i: number): NoteDocument {
  const words = Array.from({ length: WORDS_PER_BODY }, (_, k) => `word${(i * 7 + k) % VOCABULARY_SIZE}`)
  return { id: `note-${i}`, title: i % TAXI_EVERY === 0 ? `taxi fare ${i}` : `bus ticket ${i}`, body: words.join(' ') }
}

function crossing(i: number): NoteDocument {
  return { id: `extra-${i}`, title: `bus ticket extra ${i}`, body: 'word1 word2' }
}

function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError
}

function isDepartedThreadRefusal(response: HttpResult<unknown>): boolean {
  const body = response.body as { error?: { code?: unknown } } | null
  return response.status === 503 && body?.error?.code === 'WORKER_CRASHED'
}

describe.skipIf(!built)('request threads reading an index whose copies load, die, and drop', () => {
  let srv: TestServer
  let mainQueries = 0
  const threadIds: number[] = []
  let channel: BroadcastChannel

  beforeEach(async () => {
    threadIds.length = 0
    channel = new BroadcastChannel(KILL_CHANNEL)
    channel.onmessage = message => {
      const announcement = (message as { data: ThreadAnnouncement }).data
      if (typeof announcement?.threadId === 'number') threadIds.push(announcement.threadId)
    }
    srv = await startTestServer(
      undefined,
      { workers: { count: 2, idleTimeoutMs: COPY_IDLE_TIMEOUT_MS, bootstrapModule: bootstrapModule() } },
      async engine => {
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

  async function withRetries<T>(request: () => Promise<HttpResult<T>>): Promise<HttpResult<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await request()
        if (isDepartedThreadRefusal(response) && attempt < RETRIES_PER_READ) continue
        return response
      } catch (error) {
        if (!isTransportFailure(error) || attempt >= RETRIES_PER_READ) throw error
      }
    }
  }

  function expectOk(response: HttpResult<unknown>, what: string): void {
    expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(200)
  }

  async function insert(documents: NoteDocument[]): Promise<void> {
    const written = await postJson<{ failed: unknown[] }>(srv.base, `/indexes/${INDEX}/documents/_batch`, {
      action: 'insert',
      documents,
      options: { wait: true },
    })
    expectOk(written, 'an insert')
    expect(written.body.failed).toEqual([])
  }

  async function scaledOut(): Promise<boolean> {
    const stats = await srv.engine.getMemoryStats()
    return stats.workerCopies.some(copy => copy.indexName === INDEX && copy.scaledOut)
  }

  async function searchesStayOnThreads(): Promise<boolean> {
    const before = mainQueries
    await Promise.all(
      Array.from({ length: ROUTING_PROBES }, () =>
        withRetries(() => postJson(srv.base, `/indexes/${INDEX}/search`, { term: 'taxi', limit: 1 })),
      ),
    )
    return mainQueries === before
  }

  function readerChecks(base: NoteDocument[], totals: readonly number[]): Array<() => Promise<void>> {
    const taxiIds = base
      .filter(document => document.title.startsWith('taxi'))
      .map(document => document.id)
      .sort()
    const sample = base.filter((_, i) => i % Math.floor(base.length / SAMPLED_DOCUMENTS) === 0)
    let turn = 0
    const nextSample = (): NoteDocument => {
      turn += 1
      return sample[turn % sample.length]
    }
    return [
      async () => {
        const answer = await withRetries(() =>
          postJson<{ hits: Array<{ id: string; document: { title?: string } }>; count: number }>(
            srv.base,
            `/indexes/${INDEX}/search`,
            { term: 'taxi', document: { include: ['title'] }, limit: BASE_DOCUMENTS },
          ),
        )
        expectOk(answer, 'a search for taxi')
        expect(answer.body.count, 'the taxi count').toBe(taxiIds.length)
        expect(answer.body.hits.map(hit => hit.id).sort(), 'the taxi hits').toEqual(taxiIds)
        for (const hit of answer.body.hits) expect(hit.document.title?.startsWith('taxi')).toBe(true)
      },
      async () => {
        const answer = await withRetries(() =>
          postJson<{ count: number }>(srv.base, `/indexes/${INDEX}/search/preflight`, { term: 'taxi' }),
        )
        expectOk(answer, 'a preflight for taxi')
        expect(answer.body.count, 'the preflight count').toBe(taxiIds.length)
      },
      async () => {
        const answer = await withRetries(() => getJson<{ count: number }>(srv.base, `/indexes/${INDEX}/count`))
        expectOk(answer, 'a count')
        expect(totals, 'the document count').toContain(answer.body.count)
      },
      async () => {
        const expected = nextSample()
        const answer = await withRetries(() =>
          getJson<{ document: NoteDocument }>(srv.base, `/indexes/${INDEX}/documents/${expected.id}`),
        )
        expectOk(answer, `a read of ${expected.id}`)
        expect(answer.body.document).toEqual(expected)
      },
      async () => {
        const expected = nextSample()
        const answer = await withRetries(() =>
          postJson<{ documents: Record<string, NoteDocument> }>(srv.base, `/indexes/${INDEX}/documents/_multi-get`, {
            docIds: [expected.id, 'nobody-inserted-this'],
          }),
        )
        expectOk(answer, `a multi-get of ${expected.id}`)
        expect(answer.body.documents).toEqual({ [expected.id]: expected })
      },
    ]
  }

  async function readWhile(checks: Array<() => Promise<void>>, until: () => Promise<boolean>): Promise<void> {
    let reading = true
    const readers = Array.from({ length: READERS }, async (_, reader) => {
      for (let turn = reader; reading; turn += 1) await checks[turn % checks.length]()
    })
    const failure = Promise.all(readers).then(
      () => null,
      (error: unknown) => error,
    )
    try {
      const deadline = Date.now() + COPY_LOAD_TIMEOUT_MS
      while (!(await until())) {
        if (Date.now() > deadline) throw new Error('The copies never finished loading')
        const failed = await Promise.race([failure, new Promise(resolve => setTimeout(() => resolve(null), 25))])
        if (failed !== null) throw failed
      }
    } finally {
      reading = false
    }
    const failed = await failure
    if (failed !== null) throw failed
  }

  it('answers every read from the whole index while a copy loads, after a worker dies mid-load, and across an idle drop and reload', async () => {
    const created = await postJson(srv.base, '/indexes', {
      name: INDEX,
      config: { schema: { title: 'string', body: 'string' } },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await waitFor(async () => threadIds.length >= 2)
    const base = Array.from({ length: BASE_DOCUMENTS }, (_, i) => note(i))
    await insert(base)
    const extras = Array.from({ length: DOCUMENTS_THAT_CROSS_THE_COPY_THRESHOLD }, (_, i) => crossing(i))
    const checks = readerChecks(base, [BASE_DOCUMENTS, BASE_DOCUMENTS + extras.length])

    const startingThreads = [...threadIds]
    let killed = false
    await readWhile(checks, async () => {
      if (!killed) {
        killed = true
        await insert(extras)
        channel.postMessage({ kill: startingThreads[0] })
      }
      return threadIds.length > startingThreads.length && (await scaledOut()) && (await searchesStayOnThreads())
    })
    expect(threadIds.length, 'a replacement worker started').toBeGreaterThan(startingThreads.length)

    await waitFor(async () => !(await scaledOut()), COPY_LOAD_TIMEOUT_MS)
    const relayedBeforeReload = mainQueries
    await readWhile(checks, async () => (await scaledOut()) && (await searchesStayOnThreads()))
    expect(mainQueries, 'the main thread answered while the copies reloaded').toBeGreaterThan(relayedBeforeReload)

    const before = mainQueries
    for (const check of checks) await check()
    expect(mainQueries, 'the reloaded copies answer searches on the threads').toBe(before)
  }, 600_000)
})
