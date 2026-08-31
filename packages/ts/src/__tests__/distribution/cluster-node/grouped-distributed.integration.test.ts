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
})
