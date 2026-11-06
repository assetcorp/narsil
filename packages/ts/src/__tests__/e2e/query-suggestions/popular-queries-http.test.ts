import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { createNarsil } from '../../../narsil'
import { querySuggestions } from '../../../query-suggestions'
import { startTestServer, type TestServer } from '../../server/helpers'

const KEY_TEXT = 'a popular query key that is long enough for the engine'
const SOURCE = 'catalogue'
const GROUP = 'shoppers'
const SUGGESTIONS = `${SOURCE}.suggestions.${GROUP}`
const MIN_PEOPLE = 2
const SETTING = { enabled: true, fields: ['title'], minPeople: MIN_PEOPLE, minResults: 1, schedule: 'off' }
const TITLES = [
  'trail running shoes',
  'trail shoes for mud',
  'waterproof hiking boots',
  'hiking socks',
  'red rain jacket',
]
const UNMATCHED_PHRASE = 'velvet sofa'
const PHONE_SEARCH = 'call me on 0244123456'

const SEARCHES: Array<{ person: string; query: string }> = [
  { person: 'person-1', query: 'Trail Shoes' },
  { person: 'person-2', query: 'trail   shoes' },
  { person: 'person-1', query: 'hiking boots' },
  { person: 'person-1', query: 'hiking boots' },
  { person: 'person-3', query: 'Hiking Boots' },
  { person: 'person-4', query: 'rain jacket' },
  { person: 'person-1', query: UNMATCHED_PHRASE },
  { person: 'person-2', query: UNMATCHED_PHRASE },
  { person: 'person-1', query: PHONE_SEARCH },
  { person: 'person-2', query: PHONE_SEARCH },
]

function expectedSuggestions(searches = SEARCHES, banned: string[] = []): Map<string, number> {
  const peopleByPhrase = new Map<string, Set<string>>()
  for (const { person, query } of searches) {
    const phrase = query.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
    const digits = phrase.replace(/[^0-9]/g, '').length
    if (digits > 5 || banned.includes(phrase)) continue
    const people = peopleByPhrase.get(phrase) ?? new Set<string>()
    people.add(person)
    peopleByPhrase.set(phrase, people)
  }
  const found = new Map<string, number>()
  for (const [phrase, people] of peopleByPhrase) {
    const matches = TITLES.some(title => phrase.split(' ').every(word => title.split(' ').includes(word)))
    if (people.size >= MIN_PEOPLE && matches) found.set(phrase, people.size)
  }
  return found
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (item.isFile()) found.push(join(item.parentPath, item.name))
  }
  return found
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer())
}

async function storedSuggestions(client: NarsilClient): Promise<Map<string, number>> {
  const listed = await client.listDocuments<{ count: number }>(SUGGESTIONS, { limit: 100 })
  return new Map(listed.documents.map(entry => [entry.id, entry.document.count]))
}

async function build(client: NarsilClient): Promise<void> {
  const task = await client.buildQuerySuggestions(SOURCE)
  expect((await client.waitForTask(task.id)).status).toBe('succeeded')
}

const directories: string[] = []
const servers: TestServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function serverWithCatalogue(): Promise<{ client: NarsilClient; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-popular-queries-'))
  directories.push(directory)
  const server = await startTestServer(
    {
      querySuggestions: {
        identify: ctx => {
          const person = ctx.headers['x-person']
          return typeof person === 'string' ? { person, group: GROUP } : null
        },
      },
    },
    { durability: { directory }, querySuggestions: { key: KEY_TEXT }, workers: { enabled: false } },
  )
  servers.push(server)
  const client = createNarsilClient({ url: server.base })
  await client.createIndex(SOURCE, { schema: { title: 'string' } })
  const inserted = await client.insertBatch(
    SOURCE,
    TITLES.map((title, at) => ({ id: `item-${at}`, title })),
  )
  expect(inserted.failed).toEqual([])
  await client.updateQuerySuggestions(SOURCE, SETTING)
  return { client, directory }
}

describe('popular query suggestions through the HTTP server and the published client', () => {
  it('publishes what enough people clicked and stores no person ID, key, or raw search where it should not', async () => {
    const { client, directory } = await serverWithCatalogue()
    const outcomes: string[] = []
    for (const { person, query } of SEARCHES) {
      outcomes.push((await client.recordQuery(SOURCE, query, { headers: { 'x-person': person } })).outcome)
    }
    expect(outcomes.filter(outcome => outcome === 'invalid')).toHaveLength(2)
    expect((await client.recordQuery(SOURCE, 'trail shoes')).outcome).toBe('unidentified')

    const preview = await client.previewQuerySuggestions(SOURCE)
    expect(new Map(preview.entries.map(entry => [entry.query, entry.count]))).toEqual(expectedSuggestions())

    await build(client)
    expect(await storedSuggestions(client)).toEqual(expectedSuggestions())
    const found = await client.query(SUGGESTIONS, { term: 'hik', prefix: true, termMatch: 'all' })
    expect(found.hits.map(hit => hit.id)).toEqual(['hiking boots'])

    const secrets = ['person-1', 'person-2', 'person-3', 'person-4', KEY_TEXT, '0244123456']
    for (const path of await filesUnder(directory)) {
      const bytes = await readFile(path)
      for (const secret of secrets) expect({ path, holds: bytes.includes(secret) }).toEqual({ path, holds: false })
    }

    const plain = await bytesOf(await client.snapshot(SOURCE))
    expect(plain.includes(UNMATCHED_PHRASE)).toBe(false)
    const withHistory = await bytesOf(await client.snapshot(SOURCE, { queryHistory: true }))
    expect(withHistory.includes(UNMATCHED_PHRASE)).toBe(true)
    for (const secret of secrets) expect(withHistory.includes(secret)).toBe(false)
  }, 30_000)

  it('keeps a banned phrase out of every later build and deletes the counts with the index', async () => {
    const { client, directory } = await serverWithCatalogue()
    for (const { person, query } of SEARCHES)
      await client.recordQuery(SOURCE, query, { headers: { 'x-person': person } })
    await build(client)
    expect((await storedSuggestions(client)).has('trail shoes')).toBe(true)

    expect(await client.replaceQueryBans(SOURCE, ['Trail  Shoes'])).toEqual(['trail shoes'])
    expect((await storedSuggestions(client)).has('trail shoes')).toBe(false)
    const laterSearches = [
      { person: 'person-5', query: 'trail shoes' },
      { person: 'person-5', query: 'rain jacket' },
    ]
    const laterOutcomes: string[] = []
    for (const { person, query } of laterSearches) {
      laterOutcomes.push((await client.recordQuery(SOURCE, query, { headers: { 'x-person': person } })).outcome)
    }
    expect(laterOutcomes[0]).toBe('banned')
    await build(client)
    const afterBan = expectedSuggestions([...SEARCHES, ...laterSearches], ['trail shoes'])
    expect(afterBan.get('rain jacket')).toBe(2)
    expect(await storedSuggestions(client)).toEqual(afterBan)

    await client.dropIndex(SOURCE)
    expect((await client.listIndexes()).map(index => index.name)).toEqual([])
    const counts = join(directory, '_query-counts', SOURCE)
    expect(
      await stat(counts).then(
        () => filesUnder(counts),
        () => [],
      ),
    ).toEqual([])
  }, 30_000)

  it('keeps the counts of the day across a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-popular-restart-'))
    directories.push(directory)
    const config = { durability: { directory }, querySuggestions: { key: KEY_TEXT }, workers: { enabled: false } }
    const first = await createNarsil(config)
    await first.createIndex(SOURCE, { schema: { title: 'string' } })
    await first.insert(SOURCE, { title: TITLES[0] }, 'item-0')
    await querySuggestions(first).updateSetting(SOURCE, SETTING)
    await querySuggestions(first).recordQuery(SOURCE, { query: 'trail shoes', person: 'person-1', group: GROUP })
    await first.shutdown()

    const second = await createNarsil(config)
    try {
      const reopened = querySuggestions(second)
      await reopened.recordQuery(SOURCE, { query: 'trail shoes', person: 'person-2', group: GROUP })
      expect((await reopened.preview(SOURCE)).entries).toEqual([{ group: GROUP, query: 'trail shoes', count: 2 }])
    } finally {
      await second.shutdown()
    }
  }, 30_000)
})
