import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerTokenizer } from '../../../analysis/registry'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import { postJson } from '../../server/helpers'
import { INDEX, LANGUAGE_NAME, pantryCorpus, registerPantryLanguage, SCHEMA } from './corpus'
import { NO_WORKERS, PANTRY_CONFIG, type PantryServer, startPantryServer } from './harness'

vi.setConfig({ testTimeout: 60_000 })

const servers: PantryServer[] = []
const engines: Narsil[] = []
let directory: string | null = null

beforeAll(() => {
  registerPantryLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const engine of engines.splice(0)) await engine.shutdown()
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

async function pantryServer(trackPositions?: boolean): Promise<PantryServer> {
  const server = await startPantryServer({ workers: NO_WORKERS })
  servers.push(server)
  await server.client.createIndex(INDEX, {
    ...PANTRY_CONFIG,
    ...(trackPositions === undefined ? {} : { trackPositions }),
  })
  await server.client.insertBatch(INDEX, [
    { id: 'a', title: 'olive oil', body: 'bread', tags: [], shelf: 0 },
    { id: 'b', title: 'bread', body: 'pasta', tags: [], shelf: 0 },
  ])
  return server
}

interface SearchAnswer {
  hits?: Array<{ id: string }>
  error?: { code?: string; message?: string }
  code?: string
  message?: string
}

async function search(server: PantryServer, body: unknown) {
  return postJson<SearchAnswer>(server.base, `/indexes/${INDEX}/search`, body)
}

function words(count: number): string {
  return Array.from({ length: count }, (_, at) => `w${String.fromCharCode(97 + (at % 26))}x`).join(' ')
}

describe('a hostile phrase through the HTTP server', () => {
  it.each([
    ['a phrase one word over the limit', `"${words(33)}"`],
    ['a phrase whose stop words carry it over the limit', `"olive ${'the '.repeat(31)}oil"`],
    ['a query one phrase over the limit', Array.from({ length: 33 }, (_, at) => `"${words(at + 1)}"`).join(' ')],
  ])('answers 400 SEARCH_INVALID_PHRASE for %s', async (_case, term) => {
    const server = await pantryServer()
    const answer = await search(server, { term })
    expect(answer.status).toBe(400)
    expect(JSON.stringify(answer.body)).toContain(ErrorCodes.SEARCH_INVALID_PHRASE)
    const count = await postJson(server.base, `/indexes/${INDEX}/search/preflight`, { term })
    expect(count.status).toBe(400)
  })

  it('accepts a phrase and a query exactly at each limit', async () => {
    const server = await pantryServer()
    expect((await search(server, { term: `"${words(32)}"` })).status).toBe(200)
    expect((await search(server, { term: `"olive ${'the '.repeat(30)}oil"` })).status).toBe(200)
    const phrases = Array.from({ length: 32 }, (_, at) => `"${words((at % 3) + 1)} ${at}x"`).join(' ')
    expect((await search(server, { term: phrases })).status).toBe(200)
  })

  it('reads an unclosed quote as a phrase to the end of the term', async () => {
    const server = await pantryServer()
    const answer = await search(server, { term: 'bread "olive oil' })
    expect(answer.body.hits?.map(hit => hit.id)).toEqual(['a'])
  })

  it('drops empty quotes and a phrase of stop words, and searches the rest', async () => {
    const server = await pantryServer()
    for (const term of ['"" pasta', '"   " pasta', '"the of" pasta', 'pasta "the', 'pasta "']) {
      const answer = await search(server, { term })
      expect(answer.status, term).toBe(200)
      expect(
        answer.body.hits?.map(hit => hit.id),
        term,
      ).toEqual(['b'])
    }
    for (const term of ['""', '"the"', '"']) {
      const answer = await search(server, { term })
      expect(answer.status, term).toBe(200)
      expect(answer.body.hits, term).toEqual([])
    }
  })

  it('refuses a phrase on an index that tracks no positions, while it searches words and a dropped phrase', async () => {
    const server = await pantryServer(false)
    const refused = await search(server, { term: '"olive oil"' })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.body)).toContain(ErrorCodes.SEARCH_INVALID_PHRASE)
    expect((await search(server, { term: 'olive' })).body.hits?.map(hit => hit.id)).toEqual(['a'])
    expect((await search(server, { term: '"" olive' })).body.hits?.map(hit => hit.id)).toEqual(['a'])
  })

  it('applies a phrase to the keyword side of a hybrid query alone, and refuses one over the limit there too', async () => {
    const engine = await createNarsil({ workers: NO_WORKERS })
    engines.push(engine)
    await engine.createIndex(INDEX, { schema: { title: 'string', v: 'vector[2]' }, language: LANGUAGE_NAME })
    await engine.insert(INDEX, { title: 'olive oil', v: [0, 1] }, 'phrase-holder')
    await engine.insert(INDEX, { title: 'oil olive', v: [1, 0] }, 'nearest-vector')
    const vector = { field: 'v', value: [1, 0] }

    const hybrid = await engine.query(INDEX, { mode: 'hybrid', term: '"olive oil"', vector, limit: 10 })
    expect(hybrid.hits.map(hit => hit.id).sort()).toEqual(['nearest-vector', 'phrase-holder'])
    const keyword = await engine.query(INDEX, { term: '"olive oil"' })
    expect(keyword.hits.map(hit => hit.id)).toEqual(['phrase-holder'])

    await expect(engine.query(INDEX, { mode: 'hybrid', term: `"${words(33)}"`, vector })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_PHRASE,
    })
  })
})

describe('a tokeniser that returns its positions out of order', () => {
  it('still matches a phrase on a growing segment and on a saved one', async () => {
    registerTokenizer('phrase-backwards', {
      tokenize: text =>
        text
          .split(' ')
          .map((token, position) => ({ token, position }))
          .reverse(),
    })
    directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-backwards-'))
    const config = { durability: { directory }, workers: NO_WORKERS }
    const writer = await createNarsil(config)
    await writer.createIndex(INDEX, { schema: { title: 'string' }, tokenizer: 'phrase-backwards' })
    await writer.insertBatch(INDEX, [
      { id: 'in-order', title: 'cold olive oil here' },
      { id: 'reversed', title: 'oil olive cold' },
    ])
    expect((await writer.query(INDEX, { term: '"olive oil"' })).hits.map(hit => hit.id)).toEqual(['in-order'])
    await writer.checkpoint(INDEX)
    await writer.shutdown()

    const reader = await createNarsil(config)
    engines.push(reader)
    expect((await reader.query(INDEX, { term: '"olive oil"' })).hits.map(hit => hit.id)).toEqual(['in-order'])
  })
})

describe('the work that a phrase may spend', () => {
  it('stops with SEARCH_WORK_CAP_EXCEEDED and counts across partitions', async () => {
    const engine = await createNarsil({ workers: NO_WORKERS, patternWorkCap: 500 })
    engines.push(engine)
    await engine.createIndex(INDEX, { schema: SCHEMA, language: LANGUAGE_NAME, partitions: { maxPartitions: 4 } })
    const documents = Array.from({ length: 400 }, (_, at) => ({
      id: `d${at}`,
      title: 'olive oil olive oil',
      body: 'x',
      tags: [],
      shelf: 0,
    }))
    await engine.insertBatch(INDEX, documents)
    await expect(engine.query(INDEX, { term: '"olive oil"' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    })
    await expect(engine.preflight(INDEX, { term: '"olive oil"' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    })
    expect((await engine.query(INDEX, { term: 'olive oil' })).count).toBe(400)
  })

  it('keeps reported memory flat across repeated phrase queries on a saved segment', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-memory-'))
    const config = { durability: { directory }, workers: NO_WORKERS }
    const writer = await createNarsil(config)
    await writer.createIndex(INDEX, PANTRY_CONFIG)
    await writer.insertBatch(INDEX, pantryCorpus(2_000, 11))
    await writer.checkpoint(INDEX)
    await writer.shutdown()

    const reader = await createNarsil(config)
    engines.push(reader)
    await reader.query(INDEX, { term: '"olive oil"' })
    const before = (await reader.getMemoryStats()).estimatedIndexBytes
    for (let round = 0; round < 50; round++) {
      await reader.query(INDEX, { term: '"olive oil" "state of the art" pasta' })
      await reader.preflight(INDEX, { term: '"oil oil"' })
    }
    expect((await reader.getMemoryStats()).estimatedIndexBytes).toBe(before)
  })
})
