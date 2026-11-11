import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AnyDocument } from '../../../types/schema'
import { type SingleNodeCluster, startSingleNodeCluster, waitForActiveAllocation } from './cluster-harness'

describe('grouping on the distributed query path', () => {
  let cluster: SingleNodeCluster

  beforeEach(async () => {
    cluster = await startSingleNodeCluster()
    await cluster.node.createIndex('products', { schema: { title: 'string', category: 'string', price: 'number' } })
    await waitForActiveAllocation(cluster.coordinator, 'products')
    await cluster.node.insert('products', { title: 'widget spanner', category: 'tools', price: 10 }, 'spanner')
    await cluster.node.insert('products', { title: 'widget wrench', category: 'tools', price: 20 }, 'wrench')
    await cluster.node.insert('products', { title: 'widget mug', category: 'kitchen', price: 5 }, 'mug')
  })

  afterEach(async () => {
    await cluster.shutdown()
  })

  it('returns merged groups with their documents', async () => {
    const result = await cluster.node.query('products', {
      term: 'widget',
      group: { fields: ['category'], maxPerGroup: 2 },
    })
    const groups = result.groups ?? []
    expect(groups).toHaveLength(2)
    const tools = groups.find(group => group.values.category === 'tools')
    expect(tools?.hits.map(hit => hit.id).sort()).toEqual(['spanner', 'wrench'])
    expect(tools?.hits[0].document).toMatchObject({ category: 'tools' })
  }, 30_000)

  it('folds a reducer over each group on the caller side', async () => {
    const result = await cluster.node.query('products', {
      term: 'widget',
      group: {
        fields: ['category'],
        maxPerGroup: 2,
        reduce: {
          initialValue: () => 0,
          reducer: (total, doc: AnyDocument) => (total as number) + ((doc.price as number) ?? 0),
        },
      },
    })
    const tools = (result.groups ?? []).find(group => group.values.category === 'tools')
    expect(tools?.reduced).toBe(30)
  }, 30_000)

  it('caps the group list at the query limit', async () => {
    const result = await cluster.node.query('products', {
      term: 'widget',
      group: { fields: ['category'], maxPerGroup: 1, limit: 1 },
    })
    expect(result.groups).toHaveLength(1)
  }, 30_000)

  it('projects group hit documents the way the query asks', async () => {
    const result = await cluster.node.query('products', {
      term: 'widget',
      group: { fields: ['category'], maxPerGroup: 1 },
      document: { include: ['title'] },
    })
    const tools = (result.groups ?? []).find(group => group.values.category === 'tools')
    expect(Object.keys(tools?.hits[0].document ?? {})).toEqual(['title'])
  }, 30_000)

  it('preserves raw group ranking and reducer scores when a sorted response omits scores', async () => {
    const schema = { title: 'string', category: 'string', price: 'number' } as const
    const documents = [
      { id: 'z', title: 'widget widget widget', category: 'Z', price: 1 },
      { id: 'zz', title: 'widget widget widget widget widget widget', category: 'Z', price: 4 },
      { id: 'b', title: 'widget', category: 'Z', price: 3 },
      { id: 'a', title: 'widget', category: 'A', price: 2 },
      { id: 'c', title: 'widget', category: 'C', price: 0 },
    ]
    await cluster.node.createIndex('ordered', { schema })
    await waitForActiveAllocation(cluster.coordinator, 'ordered')
    for (const { id, ...document } of documents) await cluster.node.insert('ordered', document, id)
    const idf = Math.log(12 / 11)
    const scores = new Map([
      ['z', 1.5 * idf],
      ['zz', (12 / 7) * idf],
      ['a', idf],
      ['b', idf],
      ['c', idf],
    ])
    const params = {
      term: 'widget',
      fields: ['title'],
      scoring: 'dfs' as const,
      bm25: { k1: 1, b: 0 },
      sort: { price: 'asc' as const },
      document: false,
      limit: 2,
      group: {
        fields: ['category'],
        maxPerGroup: 2,
        reduce: {
          initialValue: () => 0,
          reducer: (total: unknown, _document: AnyDocument, score: number) => Number(total) + score,
        },
      },
    }
    const answer = await cluster.node.query('ordered', params)
    expect(answer.groups?.map(group => group.values.category)).toEqual(['Z', 'A', 'C'])
    expect(answer.groups?.[0].hits.map(hit => hit.id)).toEqual(['z', 'b'])
    expect(answer.groups?.[0].reduced).toBeCloseTo((1.5 + 12 / 7 + 1) * idf, 12)
    for (const hit of [...answer.hits, ...(answer.groups?.flatMap(group => group.hits) ?? [])]) {
      expect(hit.score).toBeUndefined()
      expect(hit.document).toEqual({})
    }
    const scored = await cluster.node.query('ordered', { ...params, includeScores: true })
    for (const hit of [...scored.hits, ...(scored.groups?.flatMap(group => group.hits) ?? [])]) {
      expect(hit.score).toBeCloseTo(scores.get(hit.id) ?? -1, 12)
    }
  }, 30_000)
})
