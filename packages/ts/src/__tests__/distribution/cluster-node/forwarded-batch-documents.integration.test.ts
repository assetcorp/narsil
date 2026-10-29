import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import { waitForActiveAllocation } from './cluster-harness'

const INDEX_NAME = 'atlas'

type Sheet = {
  id: string
  title: string
  latitude: number
}

function sheets(): Sheet[] {
  return Array.from({ length: 40 }, (_, index) => ({
    id: `sheet-${index}`,
    title: `coastal chart ${index} ${'s'.repeat(index * 37)}`,
    latitude: index % 2 === 0 ? index - 20.5 : index,
  }))
}

describe('a batch that a router forwards to the primary of another node', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const running: ClusterNode[] = []

  async function start(nodeId: string, roles: Array<'data' | 'coordinator' | 'controller'>): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: nodeId,
      nodeId,
      roles,
    })
    running.push(node)
    await node.start()
    return node
  }

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
  })

  it('stores every document exactly as the caller sent it', async () => {
    const router = await start('chart-room', ['coordinator', 'controller'])
    await start('map-store', ['data'])
    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string', latitude: 'number' } },
      { partitionCount: 2, replicationFactor: 0 },
    )
    await waitForActiveAllocation(coordinator, INDEX_NAME)
    const oracle = sheets()

    const result = await router.insertBatch(INDEX_NAME, oracle)
    expect(result.failed).toEqual([])

    const stored = await router.getMultiple(
      INDEX_NAME,
      oracle.map(sheet => sheet.id),
    )
    for (const sheet of oracle) {
      const document = stored.get(sheet.id)
      expect(document?.title).toBe(sheet.title)
      expect(document?.latitude).toBe(sheet.latitude)
    }
  }, 60_000)

  it('reads negative zero back from a node that holds no copy, at the top level, nested, and in an array', async () => {
    const router = await start('chart-room', ['coordinator', 'controller'])
    await start('map-store', ['data'])
    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string', latitude: 'number' } },
      { partitionCount: 2, replicationFactor: 0 },
    )
    await waitForActiveAllocation(coordinator, INDEX_NAME)
    const meridian = { title: 'prime meridian', latitude: -0, origin: { longitude: -0 }, soundings: [3, -0, 7] }
    await router.insert(INDEX_NAME, meridian, 'meridian')

    function keepsNegativeZero(document: Record<string, unknown> | undefined): void {
      const origin = document?.origin as { longitude?: unknown } | undefined
      const soundings = document?.soundings as unknown[] | undefined
      expect(Object.is(document?.latitude, -0)).toBe(true)
      expect(Object.is(origin?.longitude, -0)).toBe(true)
      expect(soundings?.length).toBe(3)
      expect(Object.is(soundings?.[1], -0)).toBe(true)
      expect(soundings?.[0]).toBe(3)
    }

    keepsNegativeZero(await router.get(INDEX_NAME, 'meridian'))
    keepsNegativeZero((await router.getMultiple(INDEX_NAME, ['meridian'])).get('meridian'))
    const searched = await router.query(INDEX_NAME, { term: 'meridian', sort: { latitude: 'asc' } })
    expect(searched.hits.map(hit => hit.id)).toEqual(['meridian'])
    keepsNegativeZero(searched.hits[0]?.document)
    const listed = await router.listDocuments(INDEX_NAME, {})
    keepsNegativeZero(listed.documents.find(entry => entry.id === 'meridian')?.document)
  }, 60_000)
})
