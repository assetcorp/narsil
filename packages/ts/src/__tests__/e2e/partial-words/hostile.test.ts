import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ErrorEnvelope } from '../../../server/types/options'
import type { AnyDocument } from '../../../types/schema'
import { postJson } from '../../server/helpers'
import { INDEX, registerWorkshopLanguage, workshopCorpus } from './corpus'
import {
  createWorkshopIndex,
  expectSameHits,
  NO_WORKERS,
  type SearchFn,
  searchOver,
  startWorkshopServer,
  type WorkshopServer,
} from './harness'
import { createOracle, type OracleQuery } from './oracle'

const SUFFIX_LETTERS = 'abcdefghjk'
const SHARED_WORDS = ['qua', 'kel', 'mor']
const CANDIDATES_PER_WORD = 60
const BUDGET_WORDS = 60

function suffixOf(at: number): string {
  return `${SUFFIX_LETTERS[Math.floor(at / SUFFIX_LETTERS.length)]}${SUFFIX_LETTERS[at % SUFFIX_LETTERS.length]}`
}

function budgetWordOf(at: number): string {
  return `v${suffixOf(at)}`
}

const CROSS_FIELD_DOCUMENTS: AnyDocument[] = [
  { id: 'oilskin-in-title', title: 'oilskin', body: 'paint' },
  { id: 'oilskin-in-body', title: 'bench', body: 'oilskins' },
  { id: 'oil-in-title', title: 'oil', body: 'chair' },
  { id: 'filler', title: 'table lamp', body: 'brush' },
]

function shareDocuments(): AnyDocument[] {
  return SHARED_WORDS.flatMap(word =>
    Array.from({ length: CANDIDATES_PER_WORD }, (_, at) => ({
      id: `${word}-${String(at).padStart(2, '0')}`,
      title: `${word}${suffixOf(at)}`,
      body: 'paint',
    })),
  )
}

function budgetDocuments(): AnyDocument[] {
  return Array.from({ length: BUDGET_WORDS }, (_, at) => ({
    id: `budget-${String(at).padStart(2, '0')}`,
    title: `x${budgetWordOf(at)}y`,
    body: 'brush',
  }))
}

async function searchStatus(server: WorkshopServer, body: unknown): Promise<{ status: number; code: string | null }> {
  const response = await postJson<ErrorEnvelope>(server.base, `/indexes/${INDEX}/search`, body)
  return { status: response.status, code: response.body?.error?.code ?? null }
}

async function createStatus(server: WorkshopServer, name: string, config: unknown) {
  const response = await postJson<ErrorEnvelope>(server.base, '/indexes', { name, config })
  return { status: response.status, code: response.body?.error?.code ?? null }
}

describe('a server facing hostile partial-word searches', () => {
  let server: WorkshopServer
  let search: SearchFn
  const documents = [...workshopCorpus(400, 61), ...CROSS_FIELD_DOCUMENTS, ...shareDocuments(), ...budgetDocuments()]
  const oracle = createOracle(documents)

  beforeAll(async () => {
    registerWorkshopLanguage()
    server = await startWorkshopServer({ workers: NO_WORKERS })
    await createWorkshopIndex(server, documents)
    search = searchOver(server.client)
  }, 60_000)

  afterAll(async () => {
    await server.stop()
  })

  it('rejects every partialWords value other than true or false with CONFIG_INVALID', async () => {
    for (const partialWords of ['yes', 'true', 1, 0, null, {}, [], [true]]) {
      expect(await searchStatus(server, { term: 'proof', partialWords }), JSON.stringify(partialWords)).toEqual({
        status: 400,
        code: 'CONFIG_INVALID',
      })
    }
    expect((await searchStatus(server, { term: 'proof', partialWords: true })).status).toBe(200)
  })

  it('refuses a partial field in an index that turns surface forms off, and partial on a type without words', async () => {
    expect(
      await createStatus(server, 'no-surfaces', { schema: { title: 'string:partial' }, surfaceForms: false }),
    ).toEqual({ status: 400, code: 'CONFIG_INVALID' })
    for (const type of ['verbatim:partial', 'number:partial', 'string:partial:partial']) {
      expect(await createStatus(server, 'bad-type', { schema: { title: type } }), type).toEqual({
        status: 400,
        code: 'SCHEMA_INVALID_TYPE',
      })
    }
    expect((await createStatus(server, 'surfaces-on', { schema: { title: 'string:partial' } })).status).toBe(201)
  })

  it('matches inside a word only in a partial field, and scores it by the length of the word as written', async () => {
    const inside = await search({ term: 'ilskin', partialWords: true })
    expect(inside.map(hit => hit.id)).toEqual(['oilskin-in-title'])
    expectSameHits(inside, oracle.search({ term: 'ilskin', partialWords: true }), 'ilskin')
    const plain = await search({ term: 'oilskin', fields: ['title'] })
    expect(inside[0].score).toBeCloseTo((plain[0].score * 6) / 7, 12)
    expect(await search({ term: 'ilskins', partialWords: true })).toEqual([])

    const both = { term: 'oil oilskin', partialWords: true, termMatch: 'all' as const }
    expect((await search(both)).map(hit => hit.id)).toEqual(['oilskin-in-title'])
    expectSameHits(await search(both), oracle.search(both), 'oil oilskin')
  })

  it('leaves a search unchanged for a word under three code points, under exact, and over fields that hold no partial words', async () => {
    const pairs: Array<[OracleQuery, OracleQuery]> = [
      [{ term: 'ra', partialWords: true }, { term: 'ra' }],
      [
        { term: 'ra ill', partialWords: true, exact: true },
        { term: 'ra ill', exact: true },
      ],
      [
        { term: 'proof coat', partialWords: true, fields: ['body'] },
        { term: 'proof coat', fields: ['body'] },
      ],
    ]
    for (const [withPartial, without] of pairs) {
      const label = JSON.stringify(withPartial)
      const found = await search(withPartial)
      expect(found, label).toEqual(await search(without))
      expectSameHits(found, oracle.search(without), label)
    }
    const widened = await search({ term: 'ill', partialWords: true })
    expect(widened).not.toEqual(await search({ term: 'ill' }))
    expectSameHits(widened, oracle.search({ term: 'ill', partialWords: true }), 'ill')
  })

  it('divides the 50 added words among three query words as 17, 17, and 16, in query order', async () => {
    const hits = await search({ term: SHARED_WORDS.join(' '), partialWords: true })
    const shares = SHARED_WORDS.map(word =>
      hits
        .filter(hit => hit.id.startsWith(`${word}-`))
        .map(hit => hit.id)
        .sort(),
    )
    const firstIds = (word: string, count: number) =>
      Array.from({ length: count }, (_, at) => `${word}-${String(at).padStart(2, '0')}`)
    expect(shares).toEqual([firstIds('qua', 17), firstIds('kel', 17), firstIds('mor', 16)])
    expect(hits).toHaveLength(50)
    expectSameHits(hits, oracle.search({ term: SHARED_WORDS.join(' '), partialWords: true }), 'shares')
  })

  it('gives partial matches to the first 50 query words of three or more code points and to none after them', async () => {
    const words = Array.from({ length: BUDGET_WORDS }, (_, at) => budgetWordOf(at))
    const term = words.flatMap(word => [word, 'ab']).join(' ')
    const hits = await search({ term, partialWords: true })
    const expected = Array.from({ length: 50 }, (_, at) => `budget-${String(at).padStart(2, '0')}`)
    expect(hits.map(hit => hit.id).sort()).toEqual(expected)
    expectSameHits(hits, oracle.search({ term, partialWords: true }), 'budget')
  })

  it('rejects a cursor once the next page changes partialWords', async () => {
    const first = await server.client.query(INDEX, { term: 'proof', partialWords: true, limit: 5 })
    expect(first.cursor).toBeDefined()
    const changed = await searchStatus(server, {
      term: 'proof',
      partialWords: false,
      limit: 5,
      searchAfter: first.cursor,
    })
    expect(changed).toEqual({ status: 400, code: 'SEARCH_INVALID_CURSOR' })
    const kept = await server.client.query(INDEX, {
      term: 'proof',
      partialWords: true,
      limit: 5,
      searchAfter: first.cursor,
    })
    expect(kept.hits.some(hit => first.hits.some(earlier => earlier.id === hit.id))).toBe(false)
  })
})
