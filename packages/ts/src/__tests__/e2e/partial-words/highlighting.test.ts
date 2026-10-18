import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { NO_WORKERS, startWorkshopServer, type WorkshopServer } from './harness'

const JACKETS = 'jackets'

const DOCUMENTS: AnyDocument[] = [
  { id: 'waterproof', title: 'Waterproof jacket for the rain', body: 'waterproof seams' },
  { id: 'proof-and-waterproof', title: 'proof waterproof', body: 'proof copy' },
  { id: 'through-roughness', title: 'Walk through the roughness', body: 'trail' },
  { id: 'short-word', title: 'ra rain', body: 'drizzle' },
]

describe('highlighting the words that a partial-word search matched inside', () => {
  let server: WorkshopServer

  beforeAll(async () => {
    server = await startWorkshopServer({ workers: NO_WORKERS })
    await server.client.createIndex(JACKETS, { schema: { title: 'string:partial', body: 'string' } })
    const inserted = await server.client.insertBatch(JACKETS, DOCUMENTS)
    expect(inserted.failed).toEqual([])
  }, 60_000)

  afterAll(async () => {
    await server.stop()
  })

  async function snippets(params: QueryParams): Promise<Record<string, Record<string, string>>> {
    const result = await server.client.query(JACKETS, { ...params, highlight: { fields: ['title', 'body'] } })
    const byId: Record<string, Record<string, string>> = {}
    for (const hit of result.hits) {
      byId[hit.id] = {
        title: hit.highlights?.title?.snippet ?? '',
        body: hit.highlights?.body?.snippet ?? '',
      }
    }
    return byId
  }

  it('tags a whole word in a partial field that contains the query word, whatever its case, and leaves a plain field untagged', async () => {
    for (const term of ['proof', 'PROOF']) {
      const found = await snippets({ term, partialWords: true })
      expect(found.waterproof, term).toEqual({
        title: '<mark>Waterproof</mark> jacket for the rain',
        body: 'waterproof seams',
      })
      expect(found['proof-and-waterproof'], term).toEqual({
        title: '<mark>proof</mark> <mark>waterproof</mark>',
        body: '<mark>proof</mark> copy',
      })
    }
  })

  it('leaves a word untagged that the index drops as a stop word, even where it contains the query word', async () => {
    const found = await snippets({ term: 'ough', partialWords: true })
    expect(found['through-roughness']?.title).toBe('Walk through the <mark>roughness</mark>')
  })

  it('tags no word from inside without partialWords, under exact, over fields without a partial field, or for a query word under three characters', async () => {
    const wholeWordsOnly = '<mark>proof</mark> waterproof'
    expect((await snippets({ term: 'proof' }))['proof-and-waterproof']?.title).toBe(wholeWordsOnly)
    expect((await snippets({ term: 'proof', partialWords: true, exact: true }))['proof-and-waterproof']?.title).toBe(
      wholeWordsOnly,
    )
    expect(
      (await snippets({ term: 'proof', partialWords: true, fields: ['body'] }))['proof-and-waterproof']?.title,
    ).toBe(wholeWordsOnly)
    expect((await snippets({ term: 'ra', partialWords: true }))['short-word']?.title).toBe('<mark>ra</mark> rain')
  })
})
