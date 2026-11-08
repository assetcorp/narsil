import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
import type { HttpQueryResult } from '../../server'
import { fusionDocuments, fusionIndex, fusionQuery } from '../integration/hybrid-fusion-fixtures'
import { postJson, scaledOut, startTestServer, type TestServer, waitFor } from './helpers'

describe('HTTP score values across response paths', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it('preserves typed scores and cursor pages through the HTTP client and request threads', async () => {
    const copies = 20
    const documents = Array.from({ length: copies }, (_, copy) =>
      fusionDocuments.map(document => ({
        ...document,
        id: `${document.id}-${String(copy).padStart(2, '0')}`,
        score: 'NaN',
      })),
    ).flat()
    let mainQueries = 0
    server = await startTestServer({}, { workers: { count: 2 } }, async engine => {
      await engine.createIndex('products', { ...fusionIndex, schema: { ...fusionIndex.schema, score: 'string' } })
      expect((await engine.insertBatch('products', documents)).failed).toEqual([])
      const query = engine.query.bind(engine)
      engine.query = (index, params) => {
        mainQueries++
        return query(index, params)
      }
    })
    const serving = server
    const client = createNarsilClient({ url: serving.base })
    const { vector: _vector, hybrid: _hybrid, ...ordinary } = fusionQuery(Number.MAX_VALUE, 0)
    const query = { ...ordinary, limit: 100, group: { fields: ['kind'], maxPerGroup: copies } }
    await waitFor(() => scaledOut(serving.engine, 'products'))
    await serving.engine.waitForWrites('products')
    await waitFor(async () => {
      const before = mainQueries
      await client.query('products', query)
      return mainQueries === before
    })
    const expected = [
      { kind: 'positive', score: Number.POSITIVE_INFINITY, token: 'Infinity' },
      { kind: 'zero', score: 0, token: 0 },
      { kind: 'negative', score: Number.NEGATIVE_INFINITY, token: '-Infinity' },
      { kind: 'cancelled', score: Number.NaN, token: 'NaN' },
    ].flatMap(({ kind, score, token }) =>
      Array.from({ length: copies }, (_, copy) => ({ id: `${kind}-${String(copy).padStart(2, '0')}`, score, token })),
    )
    const before = mainQueries
    const raw = await postJson<HttpQueryResult>(serving.base, '/indexes/products/search', query)
    expect(raw.status).toBe(200)
    expect(raw.body.hits.map(({ id, score }) => ({ id, score }))).toEqual(
      expected.map(({ id, token }) => ({ id, score: token })),
    )
    expect(raw.body.groups?.flatMap(group => group.hits.map(hit => hit.score))).toEqual(expected.map(hit => hit.token))
    const decoded = await client.query('products', query)
    expect(decoded.hits.map(({ id, score }) => ({ id, score }))).toEqual(
      expected.map(({ id, score }) => ({ id, score })),
    )
    expect(decoded.hits.every(hit => hit.document.score === 'NaN')).toBe(true)
    const sorted = await client.query('products', { ...query, sort: { kind: 'asc' }, limit: 2 })
    expect(sorted.groups?.map(group => group.values.kind)).toEqual(['positive', 'zero', 'negative', 'cancelled'])
    expect(
      [...sorted.hits, ...(sorted.groups?.flatMap(group => group.hits) ?? [])].every(
        hit => !Object.hasOwn(hit, 'score'),
      ),
    ).toBe(true)
    const reached: Array<{ id: string; score?: number }> = []
    let searchAfter: string | undefined
    let nonFiniteCursor = ''
    do {
      const page = await client.query('products', { ...ordinary, limit: 17, searchAfter })
      reached.push(...page.hits.map(({ id, score }) => ({ id, score })))
      searchAfter = page.cursor
      if (searchAfter !== undefined) {
        const cursor = JSON.parse(Buffer.from(searchAfter, 'base64').toString()) as { v: number; s: unknown }
        expect(cursor.v).toBe(Number.isFinite(page.hits.at(-1)?.score) ? 4 : 5)
        if (cursor.v === 5) nonFiniteCursor = searchAfter
      }
      expect(reached.length).toBeLessThanOrEqual(expected.length)
    } while (searchAfter !== undefined)
    expect(reached).toEqual(expected.map(({ id, score }) => ({ id, score })))
    const anchor = JSON.parse(Buffer.from(nonFiniteCursor, 'base64').toString()) as Record<string, unknown>
    const bad = Buffer.from(JSON.stringify({ ...anchor, s: null })).toString('base64')
    await expect(client.query('products', { ...ordinary, searchAfter: bad })).rejects.toMatchObject({
      code: 'SEARCH_INVALID_CURSOR',
    })
    expect(mainQueries).toBe(before)
  })
})
