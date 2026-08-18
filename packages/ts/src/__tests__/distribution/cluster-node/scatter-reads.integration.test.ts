import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000
const DOCUMENT_TOTAL = 24

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

interface ShopDocument {
  id: string
  title: string
  price: number
  category: string
}

function shopDocuments(): ShopDocument[] {
  const documents: ShopDocument[] = []
  for (let index = 0; index < DOCUMENT_TOTAL; index += 1) {
    documents.push({
      id: `item-${index}`,
      title: `Portable Grinder ${index}`,
      price: index,
      category: index % 3 === 0 ? 'kitchen' : 'workshop',
    })
  }
  return documents
}

describe('cluster-node scatter-gather reads', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let router: ClusterNode | undefined
  let holderOne: ClusterNode | undefined
  let holderTwo: ClusterNode | undefined
  let transports: NodeTransport[]
  const documents = shopDocuments()

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    const routerTransport = createInMemoryTransport('router', network)
    const holderOneTransport = createInMemoryTransport('holder-1', network)
    const holderTwoTransport = createInMemoryTransport('holder-2', network)
    transports = [routerTransport, holderOneTransport, holderTwoTransport]

    holderOne = await createClusterNode({
      coordinator,
      transport: holderOneTransport,
      address: 'holder-1:9200',
      nodeId: 'holder-1',
      roles: ['data'],
    })
    await holderOne.start()

    holderTwo = await createClusterNode({
      coordinator,
      transport: holderTwoTransport,
      address: 'holder-2:9200',
      nodeId: 'holder-2',
      roles: ['data'],
    })
    await holderTwo.start()

    router = await createClusterNode({
      coordinator,
      transport: routerTransport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    await router.start()

    const bothRegistered = await pollUntil(async () => (await coordinator.listNodes()).length === 2)
    expect(bothRegistered).toBe(true)

    await router.createIndex(
      'shop',
      { schema: { title: 'string', price: 'number', category: 'enum' } },
      { partitionCount: 4, replicationFactor: 0 },
    )

    const active = await pollUntil(async () => {
      const table = await coordinator.getAllocation('shop')
      if (table === null || table.assignments.size === 0) return false
      const primaries = new Set<string>()
      for (const assignment of table.assignments.values()) {
        if (assignment.state !== 'ACTIVE' || assignment.primary === null) return false
        primaries.add(assignment.primary)
      }
      return primaries.size === 2
    })
    expect(active).toBe(true)

    const inserted = await router.insertBatch('shop', documents as unknown as Array<Record<string, unknown>>)
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    for (const node of [router, holderOne, holderTwo]) {
      if (node !== undefined) {
        await node.shutdown()
      }
    }
    router = undefined
    holderOne = undefined
    holderTwo = undefined
    for (const transport of transports) {
      await transport.shutdown()
    }
    await coordinator.shutdown()
  })

  it('counts documents exactly from every node in the cluster', async () => {
    if (router === undefined || holderOne === undefined || holderTwo === undefined) throw new Error('nodes missing')
    expect(await router.countDocuments('shop')).toBe(DOCUMENT_TOTAL)
    expect(await holderOne.countDocuments('shop')).toBe(DOCUMENT_TOTAL)
    expect(await holderTwo.countDocuments('shop')).toBe(DOCUMENT_TOTAL)
  }, 30_000)

  it('gathers index statistics across the cluster', async () => {
    if (router === undefined) throw new Error('node missing')
    const stats = await router.getStats('shop')
    expect(stats.documentCount).toBe(DOCUMENT_TOTAL)
    expect(stats.partitionCount).toBe(4)
    expect(stats.language).toBe('english')
    expect(stats.schema).toEqual({ title: 'string', price: 'number', category: 'enum' })
    expect(stats.estimatedMemoryBytes).toBeGreaterThan(0)
  }, 30_000)

  it('gathers per-partition statistics in partition order', async () => {
    if (router === undefined) throw new Error('node missing')
    const partitions = await router.getPartitionStats('shop')
    expect(partitions.map(entry => entry.partitionId)).toEqual([0, 1, 2, 3])
    expect(partitions.reduce((total, entry) => total + entry.documentCount, 0)).toBe(DOCUMENT_TOTAL)
  }, 30_000)

  it('counts a preflight across the cluster', async () => {
    if (router === undefined) throw new Error('node missing')
    const everything = await router.preflight('shop', { term: 'portable' })
    expect(everything.count).toBe(DOCUMENT_TOTAL)

    const kitchenOnly = await router.preflight('shop', {
      term: 'portable',
      filters: { fields: { category: { eq: 'kitchen' } } },
    })
    expect(kitchenOnly.count).toBe(documents.filter(doc => doc.category === 'kitchen').length)
  }, 30_000)

  it('merges suggestions with summed document frequencies', async () => {
    if (router === undefined) throw new Error('node missing')
    const result = await router.suggest('shop', { prefix: 'grind' })
    const grinder = result.terms.find(entry => entry.term.startsWith('grind'))
    expect(grinder?.documentFrequency).toBe(DOCUMENT_TOTAL)
  }, 30_000)

  it('pages through the whole cluster listing in document-id order', async () => {
    if (router === undefined) throw new Error('node missing')
    const collected: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = await router.listDocuments('shop', { limit: 5, cursor })
      expect(result.total).toBe(DOCUMENT_TOTAL)
      collected.push(...result.documents.map(listed => listed.id))
      if (result.cursor === null) break
      cursor = result.cursor
    }

    expect(collected).toHaveLength(DOCUMENT_TOTAL)
    expect(collected).toEqual([...collected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(new Set(collected)).toEqual(new Set(documents.map(doc => doc.id)))
  }, 30_000)

  it('lists a page at the maximum page size and reports the listing finished', async () => {
    if (router === undefined) throw new Error('node missing')
    const result = await router.listDocuments('shop', { limit: 10_000 })
    expect(result.documents).toHaveLength(DOCUMENT_TOTAL)
    expect(result.cursor).toBeNull()
    expect(result.total).toBe(DOCUMENT_TOTAL)
  }, 30_000)

  it('lists with a filter, a sort, and a projection across nodes', async () => {
    if (router === undefined) throw new Error('node missing')
    const kitchen = documents.filter(doc => doc.category === 'kitchen')

    const result = await router.listDocuments<ShopDocument>('shop', {
      limit: DOCUMENT_TOTAL,
      filters: { fields: { category: { eq: 'kitchen' } } },
      sort: [{ field: 'price', direction: 'desc' }],
      document: { include: ['title'] },
    })

    expect(result.total).toBe(kitchen.length)
    expect(result.documents).toHaveLength(kitchen.length)
    const expectedOrder = [...kitchen].sort((a, b) => b.price - a.price).map(doc => doc.id)
    expect(result.documents.map(listed => listed.id)).toEqual(expectedOrder)
    for (const listed of result.documents) {
      expect(Object.keys(listed.document)).toEqual(['title'])
    }
  }, 30_000)

  it('continues a sorted listing across pages with a cursor', async () => {
    if (router === undefined) throw new Error('node missing')
    const collected: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = await router.listDocuments('shop', {
        limit: 7,
        cursor,
        sort: [{ field: 'price', direction: 'asc' }],
      })
      collected.push(...result.documents.map(listed => listed.id))
      if (result.cursor === null) break
      cursor = result.cursor
    }

    const expectedOrder = [...documents].sort((a, b) => a.price - b.price).map(doc => doc.id)
    expect(collected).toEqual(expectedOrder)
  }, 30_000)

  it('fails the exact reads instead of answering partially when a holder is gone', async () => {
    if (router === undefined || holderTwo === undefined) throw new Error('nodes missing')
    await holderTwo.shutdown()
    holderTwo = undefined
    await transports[2].shutdown()

    await expect(router.countDocuments('shop')).rejects.toThrow()
    await expect(router.listDocuments('shop', { limit: 5 })).rejects.toThrow()
    await expect(router.preflight('shop', { term: 'portable' })).rejects.toThrow()
  }, 30_000)
})
