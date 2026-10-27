import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { del, getJson, postJson, startTestServer, type TestServer } from '../helpers'

const VECTOR_DIMENSION = 1536
const INSERT_BATCH_SIZE = 400
const BATCH_COUNT = 5
const TAXI_EVERY = 5
const SEARCHES_PER_SHAPE = 4
const ROUTING_PROBES = 8
const RESULT_LIMIT = 1_000
const VECTOR_LOAD_TIMEOUT_MS = 120_000
const LOADS = 3
const INDEX = 'trips'

interface TripDocument {
  id: string
  title: string
  file_id: string
  embedding: number[]
}

interface SearchHit {
  id: string
  document: Record<string, unknown>
}

interface SearchBody {
  hits: SearchHit[]
  count: number
}

function seededValues(seed: number, length: number): number[] {
  let state = seed >>> 0
  const values = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    values[i] = state / 2_147_483_648 - 1
  }
  return values
}

function trip(i: number): TripDocument {
  const taxi = i < INSERT_BATCH_SIZE && i % TAXI_EVERY === 0
  return {
    id: `trip-${i}`,
    title: taxi ? `taxi fare ${i}` : `bus ticket ${i}`,
    file_id: `file-${i}`,
    embedding: seededValues(i + 1, VECTOR_DIMENSION),
  }
}

function batchAt(index: number): TripDocument[] {
  return Array.from({ length: INSERT_BATCH_SIZE }, (_, offset) => trip(index * INSERT_BATCH_SIZE + offset))
}

function asStored(values: number[]): number[] {
  return values.map(value => Math.fround(value))
}

function taxiIdsOf(documents: readonly TripDocument[]): string[] {
  return documents
    .filter(document => document.title.split(' ').includes('taxi'))
    .map(document => document.id)
    .sort()
}

function expectStatus(response: { status: number; body: unknown }, expected: number): void {
  expect(response.status, JSON.stringify(response.body)).toBe(expected)
}

function expectWholeDocument(actual: Record<string, unknown> | undefined, expected: TripDocument): void {
  expect(actual?.title).toBe(expected.title)
  expect(actual?.file_id).toBe(expected.file_id)
  expect(actual?.embedding).toEqual(asStored(expected.embedding))
}

interface TermSearchShape {
  params: { limit: number; document?: unknown }
  expectDocument(actual: Record<string, unknown>, expected: TripDocument): void
}

const TERM_SEARCH_SHAPES: TermSearchShape[] = [
  {
    params: { document: false, limit: RESULT_LIMIT },
    expectDocument: actual => expect(actual).toEqual({}),
  },
  {
    params: { document: { include: ['file_id'] }, limit: RESULT_LIMIT },
    expectDocument: (actual, expected) => {
      expect(actual.file_id).toBe(expected.file_id)
      expect(actual).not.toHaveProperty('title')
      expect(actual).not.toHaveProperty('embedding')
    },
  },
  {
    params: { document: { exclude: ['embedding'] }, limit: RESULT_LIMIT },
    expectDocument: (actual, expected) => {
      expect(actual.title).toBe(expected.title)
      expect(actual.file_id).toBe(expected.file_id)
      expect(actual).not.toHaveProperty('embedding')
    },
  },
  {
    params: { document: { include: [], exclude: ['embedding', 'title', ''] }, limit: RESULT_LIMIT },
    expectDocument: (actual, expected) => {
      expect(actual.file_id).toBe(expected.file_id)
      expect(actual).not.toHaveProperty('title')
      expect(actual).not.toHaveProperty('embedding')
    },
  },
  {
    params: { limit: 3 },
    expectDocument: (actual, expected) => expectWholeDocument(actual, expected),
  },
  {
    params: { document: true, limit: 3 },
    expectDocument: (actual, expected) => expectWholeDocument(actual, expected),
  },
  {
    params: { document: { include: ['embedding', 'file_id'] }, limit: 3 },
    expectDocument: (actual, expected) => {
      expect(actual.file_id).toBe(expected.file_id)
      expect(actual.embedding).toEqual(asStored(expected.embedding))
      expect(actual).not.toHaveProperty('title')
    },
  },
  {
    params: { document: { include: ['title', 'embedding.missing.path'] }, limit: 3 },
    expectDocument: (actual, expected) => {
      expect(actual.title).toBe(expected.title)
      expect(actual.embedding).toEqual(asStored(expected.embedding))
      expect(actual).not.toHaveProperty('file_id')
    },
  },
]

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

describe.skipIf(!built)('request threads answering reads while they load a large vector field', () => {
  let srv: TestServer
  let mainQueries: number
  let index = ''

  beforeEach(async () => {
    srv = await startTestServer(undefined, { workers: { count: 2 } }, async engine => {
      mainQueries = 0
      const query = engine.query.bind(engine)
      engine.query = (indexName, params) => {
        mainQueries += 1
        return query(indexName, params)
      }
    })
  })

  afterEach(async () => {
    await srv.stop()
  })

  async function createIndex(name: string): Promise<void> {
    index = name
    const created = await postJson(srv.base, '/indexes', {
      name,
      config: { schema: { title: 'string', file_id: 'string', embedding: `vector[${VECTOR_DIMENSION}]` } },
    })
    expectStatus(created, 201)
  }

  async function insert(batch: TripDocument[]): Promise<void> {
    const written = await postJson<{ failed: unknown[] }>(srv.base, `/indexes/${index}/documents/_batch`, {
      action: 'insert',
      documents: batch,
      options: { wait: true },
    })
    expectStatus(written, 200)
    expect(written.body.failed).toEqual([])
  }

  async function search(params: Record<string, unknown>): Promise<SearchBody> {
    const response = await postJson<SearchBody>(srv.base, `/indexes/${index}/search`, params)
    expectStatus(response, 200)
    return response.body
  }

  async function staysOnThreads(params: Record<string, unknown>): Promise<boolean> {
    const before = mainQueries
    await Promise.all(Array.from({ length: ROUTING_PROBES }, () => search(params)))
    return mainQueries === before
  }

  async function checkTermSearches(taxiTrips: readonly TripDocument[]): Promise<void> {
    const byId = new Map(taxiTrips.map(document => [document.id, document]))
    const taxiIds = taxiIdsOf(taxiTrips)
    const requests = TERM_SEARCH_SHAPES.flatMap(shape => Array.from({ length: SEARCHES_PER_SHAPE }, () => shape))
    const answers = await Promise.all(requests.map(shape => search({ term: 'taxi', ...shape.params })))

    answers.forEach((answer, position) => {
      const shape = requests[position]
      expect(answer.count).toBe(taxiIds.length)
      const hitIds = answer.hits.map(hit => hit.id).sort()
      if (shape.params.limit >= taxiIds.length) expect(hitIds).toEqual(taxiIds)
      else expect(hitIds.length).toBe(shape.params.limit)
      for (const hit of answer.hits) {
        const expected = byId.get(hit.id)
        if (expected === undefined) throw new Error(`A search for taxi returned ${hit.id}, whose title holds no taxi`)
        shape.expectDocument(hit.document, expected)
      }
    })
  }

  async function checkNearestVector(target: TripDocument): Promise<void> {
    const answers = await Promise.all(
      Array.from({ length: SEARCHES_PER_SHAPE }, () =>
        search({
          mode: 'vector',
          vector: { field: 'embedding', value: target.embedding },
          document: { include: ['file_id'] },
          limit: 1,
        }),
      ),
    )
    for (const answer of answers) {
      expect(answer.hits.map(hit => hit.id)).toEqual([target.id])
      expect(answer.hits[0]?.document).toEqual({ file_id: target.file_id })
    }
  }

  async function checkCountsAndDocumentReads(firstBatch: readonly TripDocument[]): Promise<void> {
    const sample = firstBatch[0]
    const listedFirst = [...firstBatch].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 3)
    const [preflight, suggest, exists, single, multi, list] = await Promise.all([
      postJson<{ count: number }>(srv.base, `/indexes/${index}/search/preflight`, { term: 'taxi' }),
      postJson<{ terms: Array<{ term: string }> }>(srv.base, `/indexes/${index}/suggest`, { prefix: 'tax' }),
      getJson<{ exists: boolean }>(srv.base, `/indexes/${index}/documents/${sample.id}/_exists`),
      getJson<{ document: Record<string, unknown> }>(srv.base, `/indexes/${index}/documents/${sample.id}`),
      postJson<{ documents: Record<string, Record<string, unknown>> }>(
        srv.base,
        `/indexes/${index}/documents/_multi-get`,
        { docIds: [sample.id, 'nobody-inserted-this'] },
      ),
      postJson<{ documents: Array<{ id: string; document: Record<string, unknown> }> }>(
        srv.base,
        `/indexes/${index}/documents/_list`,
        { limit: 3 },
      ),
    ])
    for (const response of [preflight, suggest, exists, single, multi, list]) expectStatus(response, 200)
    expect(preflight.body.count).toBe(taxiIdsOf(firstBatch).length)
    expect(suggest.body.terms.map(entry => entry.term)).toContain('taxi')
    expect(exists.body.exists).toBe(true)
    expectWholeDocument(single.body.document, sample)
    expect(Object.keys(multi.body.documents)).toEqual([sample.id])
    expectWholeDocument(multi.body.documents[sample.id], sample)
    expect(list.body.documents.map(listed => listed.id)).toEqual(listedFirst.map(document => document.id))
    list.body.documents.forEach((listed, position) => {
      expectWholeDocument(listed.document, listedFirst[position])
    })
  }

  async function loadWhileReading(name: string): Promise<number> {
    await createIndex(name)
    const firstBatch = batchAt(0)
    await insert(firstBatch)
    const taxiTrips = firstBatch.filter(document => document.title.startsWith('taxi'))

    let inserting = true
    let roundsOnThreads = 0
    const deadline = Date.now() + VECTOR_LOAD_TIMEOUT_MS
    const reads = (async () => {
      for (;;) {
        const leanStaysOnThreads = await staysOnThreads({ term: 'taxi', document: false, limit: 1 })
        const wholeStaysOnThreads = await staysOnThreads({ term: 'taxi', limit: 1 })
        if (leanStaysOnThreads || wholeStaysOnThreads) roundsOnThreads += 1
        await Promise.all([
          checkTermSearches(taxiTrips),
          checkNearestVector(firstBatch[0]),
          checkCountsAndDocumentReads(firstBatch),
        ])
        if (!inserting && wholeStaysOnThreads) return
        if (Date.now() > deadline) throw new Error('The request threads never came to hold the vectors')
      }
    })()
    const readFailure = reads.then(
      () => null,
      (error: unknown) => error,
    )

    let total = firstBatch.length
    try {
      for (let batchIndex = 1; batchIndex < BATCH_COUNT; batchIndex++) {
        const batch = batchAt(batchIndex)
        await insert(batch)
        total += batch.length
      }
    } finally {
      inserting = false
    }
    const failure = await readFailure
    if (failure !== null) throw failure

    const count = await getJson<{ count: number }>(srv.base, `/indexes/${index}/count`)
    expectStatus(count, 200)
    expect(count.body.count).toBe(total)
    const before = mainQueries
    await checkTermSearches(taxiTrips)
    expect(mainQueries).toBe(before)
    expectStatus(await del(srv.base, `/indexes/${index}`), 200)
    return roundsOnThreads
  }

  it('answers every read from the documents the caller inserted, whichever thread receives it', async () => {
    let roundsOnThreads = 0
    for (let load = 0; load < LOADS; load++) roundsOnThreads += await loadWhileReading(`${INDEX}-${load}`)
    expect(roundsOnThreads).toBeGreaterThan(0)
  }, 600_000)
})
