import { describe, expect, it } from 'vitest'
import { listBindingOf, queryBindingOf } from '../../search/cursor-binding'
import type { FilterExpression } from '../../types/filters'

describe('queryBindingOf', () => {
  it('returns 8 lowercase hex digits', () => {
    expect(queryBindingOf({ term: 'espresso' })).toMatch(/^[0-9a-f]{8}$/)
  })

  it('binds equal requests equal', () => {
    const first = queryBindingOf({ term: 'espresso', filters: { fields: { price: { gte: 10 } } } })
    const second = queryBindingOf({ term: 'espresso', filters: { fields: { price: { gte: 10 } } } })
    expect(first).toBe(second)
  })

  it('binds a changed term differently', () => {
    expect(queryBindingOf({ term: 'espresso' })).not.toBe(queryBindingOf({ term: 'decaf' }))
  })

  it('binds changed filters differently', () => {
    const base = queryBindingOf({ term: 'espresso', filters: { fields: { price: { gte: 10 } } } })
    const changed = queryBindingOf({ term: 'espresso', filters: { fields: { price: { gte: 20 } } } })
    expect(base).not.toBe(changed)
  })

  it('binds changed fields differently', () => {
    expect(queryBindingOf({ term: 'espresso', fields: ['title'] })).not.toBe(
      queryBindingOf({ term: 'espresso', fields: ['body'] }),
    )
  })

  it('binds a changed match option differently', () => {
    expect(queryBindingOf({ term: 'espresso', exact: true })).not.toBe(queryBindingOf({ term: 'espresso' }))
    expect(queryBindingOf({ term: 'espresso', tolerance: 1 })).not.toBe(queryBindingOf({ term: 'espresso' }))
    expect(queryBindingOf({ term: 'espresso', termMatch: 'all' })).not.toBe(queryBindingOf({ term: 'espresso' }))
    expect(queryBindingOf({ term: 'espresso', minScore: 0.5 })).not.toBe(queryBindingOf({ term: 'espresso' }))
  })

  it('ignores values that shape the output alone', () => {
    const base = queryBindingOf({ term: 'espresso' })
    expect(queryBindingOf({ term: 'espresso', limit: 50, offset: 10 })).toBe(base)
    expect(queryBindingOf({ term: 'espresso', includeScores: true })).toBe(base)
    expect(queryBindingOf({ term: 'espresso', highlight: { fields: ['title'] } })).toBe(base)
    expect(queryBindingOf({ term: 'espresso', facets: { category: {} } })).toBe(base)
  })

  it('ignores the sort, which the sort signature binds', () => {
    expect(queryBindingOf({ term: 'espresso', sort: { price: 'asc' } })).toBe(queryBindingOf({ term: 'espresso' }))
  })

  it('binds structurally equal filters whatever their key insertion order', () => {
    const ordered: FilterExpression = { fields: { price: { gte: 10, lte: 20 } } }
    const reversed = JSON.parse('{"fields":{"price":{"lte":20,"gte":10}}}') as FilterExpression
    expect(queryBindingOf({ term: 'espresso', filters: ordered })).toBe(
      queryBindingOf({ term: 'espresso', filters: reversed }),
    )
  })

  it('binds a float64 vector equal to the same vector as binary32', () => {
    const asNumbers = queryBindingOf({ vector: { field: 'embedding', value: [0.1, 0.2, 0.3] } })
    const asFloat32 = queryBindingOf({ vector: { field: 'embedding', value: Float32Array.from([0.1, 0.2, 0.3]) } })
    expect(asNumbers).toBe(asFloat32)
  })

  it('binds a changed vector differently', () => {
    const base = queryBindingOf({ vector: { field: 'embedding', value: [0.1, 0.2, 0.3] } })
    const changed = queryBindingOf({ vector: { field: 'embedding', value: [0.1, 0.2, 0.4] } })
    expect(base).not.toBe(changed)
  })

  it('binds vector text so an adapter re-embedding cannot break paging', () => {
    const first = queryBindingOf({ vector: { field: 'embedding', text: 'warm drinks' } })
    const second = queryBindingOf({ vector: { field: 'embedding', text: 'warm drinks' } })
    const changed = queryBindingOf({ vector: { field: 'embedding', text: 'cold drinks' } })
    expect(first).toBe(second)
    expect(first).not.toBe(changed)
  })

  it('binds an undefined-valued filter entry as null, matching the msgpack transport', () => {
    const carried = { fields: { price: { gte: 10 }, category: undefined } } as unknown as FilterExpression
    const decoded = { fields: { price: { gte: 10 }, category: null } } as unknown as FilterExpression
    expect(queryBindingOf({ term: 'espresso', filters: carried })).toBe(
      queryBindingOf({ term: 'espresso', filters: decoded }),
    )
  })

  it('binds absent and null members differently', () => {
    expect(queryBindingOf({ term: 'espresso' })).not.toBe(
      queryBindingOf({ term: 'espresso', filters: null as unknown as FilterExpression }),
    )
  })

  it('binds a changed pinned list differently', () => {
    const base = queryBindingOf({ term: 'espresso', pinned: [{ docId: 'a', position: 0 }] })
    const changed = queryBindingOf({ term: 'espresso', pinned: [{ docId: 'b', position: 0 }] })
    expect(base).not.toBe(changed)
  })

  it('binds a changed scoring mode differently', () => {
    expect(queryBindingOf({ term: 'espresso', scoring: 'dfs' })).not.toBe(queryBindingOf({ term: 'espresso' }))
    expect(queryBindingOf({ term: 'espresso', scoring: 'broadcast' })).not.toBe(
      queryBindingOf({ term: 'espresso', scoring: 'dfs' }),
    )
  })

  it('binds an omitted scoring mode as local, matching the wire default', () => {
    expect(queryBindingOf({ term: 'espresso' })).toBe(queryBindingOf({ term: 'espresso', scoring: 'local' }))
  })
})

describe('listBindingOf', () => {
  it('binds equal filters equal and changed filters differently', () => {
    const filters: FilterExpression = { fields: { category: { eq: 'tools' } } }
    expect(listBindingOf(filters)).toBe(listBindingOf({ fields: { category: { eq: 'tools' } } }))
    expect(listBindingOf(filters)).not.toBe(listBindingOf({ fields: { category: { eq: 'toys' } } }))
    expect(listBindingOf(undefined)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('binds a filterless listing to the documented worked example', () => {
    expect(listBindingOf(undefined)).toBe('05537a07')
  })
})
