import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { SortField } from '../../types/search'

describe('sort selection after field writes', () => {
  it('keeps first-field value priority and complete cursor pages', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    const rows = [
      { id: 'low', title: 'catalogue', first: 0, second: 0, enabled: true },
      { id: 'high', title: 'catalogue', first: 10, second: 100, enabled: true },
    ]
    const sort: SortField[] = [
      { field: 'first', direction: 'asc' },
      { field: 'second', direction: 'asc' },
    ]
    try {
      await engine.createIndex('stock', {
        schema: { title: 'string', first: 'number', second: 'number', enabled: 'boolean' },
      })
      await engine.insertBatch('stock', rows)
      await engine.listDocuments('stock', { sort })
      for (const [id, first, second] of [
        ['x', 3, 100],
        ['y', 4, 0],
        ['a', 3, 100],
        ['z', 3, 100],
      ] as const) {
        const row = { id, title: 'catalogue', first, second, enabled: true }
        rows.push(row)
        await engine.insert('stock', row)
      }
      await engine.insert('stock', { title: 'catalogue', first: 3, second: -1, enabled: false }, 'excluded')
      const expected = rows
        .slice()
        .sort(
          (left, right) =>
            left.first - right.first ||
            left.second - right.second ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        .map(row => row.id)
      const limit = 2
      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page <= rows.length; page++) {
        const result = await engine.query('stock', {
          term: 'catalogue',
          sort,
          limit,
          searchAfter: cursor,
          document: false,
          filters: { fields: { enabled: { eq: true } } },
        })
        expect(result.hits).toHaveLength(Math.min(limit, rows.length - seen.length))
        seen.push(...result.hits.map(hit => hit.id))
        if (result.cursor === undefined) break
        cursor = result.cursor
      }
      expect(seen).toEqual(expected)
      await engine.update('stock', 'y', { title: 'catalogue', first: 3, second: 100, enabled: true })
      await engine.remove('stock', 'x')
      const ties = await engine.query('stock', {
        term: 'catalogue',
        sort,
        limit: 2,
        filters: { fields: { first: { eq: 3 }, enabled: { eq: true } } },
      })
      expect(ties.hits.map(hit => hit.id)).toEqual(['a', 'y'])
      const last = await engine.query('stock', {
        term: 'catalogue',
        sort,
        limit: 2,
        searchAfter: ties.cursor,
        filters: { fields: { first: { eq: 3 }, enabled: { eq: true } } },
      })
      expect(last.hits.map(hit => hit.id)).toEqual(['z'])
    } finally {
      await engine.shutdown()
    }
  })
})
