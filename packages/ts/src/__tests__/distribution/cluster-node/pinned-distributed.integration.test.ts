import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type SingleNodeCluster, startSingleNodeCluster, waitForActiveAllocation } from './cluster-harness'

describe('pinned documents on the distributed query path', () => {
  let cluster: SingleNodeCluster

  beforeEach(async () => {
    cluster = await startSingleNodeCluster()
    await cluster.node.createIndex('products', { schema: { title: 'string' } })
    await waitForActiveAllocation(cluster.coordinator, 'products')
    await cluster.node.insert('products', { title: 'widget spanner' }, 'spanner')
    await cluster.node.insert('products', { title: 'widget wrench' }, 'wrench')
    await cluster.node.insert('products', { title: 'quiet promo item' }, 'promo')
  })

  afterEach(async () => {
    await cluster.shutdown()
  })

  it('pins a stored document that matched nothing and fetches its body', async () => {
    const result = await cluster.node.query('products', {
      term: 'widget',
      pinned: [{ docId: 'promo', position: 0 }],
    })
    expect(result.hits[0]).toMatchObject({ id: 'promo', document: { title: 'quiet promo item' } })
    expect(result.hits.map(hit => hit.id)).toContain('spanner')
  }, 30_000)

  it('drops a pinned id no node holds', async () => {
    const result = await cluster.node.query('products', {
      term: 'widget',
      pinned: [{ docId: 'deleted-sku', position: 0 }],
    })
    expect(result.hits.map(hit => hit.id)).not.toContain('deleted-sku')
    expect(result.hits.length).toBe(2)
  }, 30_000)

  it('drops a pinned id no node holds under a bodiless projection', async () => {
    const result = await cluster.node.query('products', {
      term: 'widget',
      pinned: [{ docId: 'deleted-sku', position: 0 }],
      document: false,
    })
    expect(result.hits.map(hit => hit.id)).not.toContain('deleted-sku')
    expect(result.hits.length).toBe(2)
  }, 30_000)
})
