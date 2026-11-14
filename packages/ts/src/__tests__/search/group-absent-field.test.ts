import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../distribution/cluster-node'
import { clusterNodeEngine } from '../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../distribution/coordinator'
import type { ClusterCoordinator } from '../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../distribution/transport/in-memory'
import type { NodeTransport } from '../../distribution/transport/types'
import { createNarsil } from '../../narsil'
import type { Narsil } from '../../types/engine'
import { postJson, startTestServer, type TestServer } from '../server/helpers'

const INDEX = 'fittings'
const SCHEMA = { title: 'string', category: 'string' } as const
const DOCUMENTS: Array<{ id: string; title: string; category?: string }> = [
  { id: 'lamp-1', title: 'brass lamp', category: 'lighting' },
  { id: 'lamp-2', title: 'brass lamp shade', category: 'lighting' },
  { id: 'hook-1', title: 'brass hook' },
  { id: 'hook-2', title: 'brass coat hook' },
  { id: 'hinge-1', title: 'brass hinge', category: 'hardware' },
]
const QUERY = { term: 'brass', limit: 20, group: { fields: ['category'], maxPerGroup: 10 } }
const PARTITION_COUNT = 3

interface GroupShape {
  values: Record<string, unknown>
  hits: Array<{ id: string }>
}

function expectedGroups(): Array<{ values: Record<string, unknown>; ids: string[] }> {
  const byCategory = new Map<string | null, string[]>()
  for (const document of DOCUMENTS) {
    const category = document.category ?? null
    byCategory.set(category, [...(byCategory.get(category) ?? []), document.id])
  }
  return comparable([...byCategory].map(([category, ids]) => ({ values: { category }, ids })))
}

function comparable(
  groups: Array<{ values: Record<string, unknown>; ids: string[] }>,
): Array<{ values: Record<string, unknown>; ids: string[] }> {
  return groups
    .map(group => ({ values: { ...group.values }, ids: [...group.ids].sort() }))
    .sort((left, right) => (JSON.stringify(left.values) < JSON.stringify(right.values) ? -1 : 1))
}

function answered(groups: GroupShape[] | undefined): Array<{ values: Record<string, unknown>; ids: string[] }> {
  return comparable((groups ?? []).map(group => ({ values: group.values, ids: group.hits.map(hit => hit.id) })))
}

async function seeded(engine: Pick<Narsil, 'createIndex' | 'insertBatch'>): Promise<void> {
  await engine.createIndex(INDEX, { schema: SCHEMA })
  expect((await engine.insertBatch(INDEX, DOCUMENTS)).failed).toEqual([])
}

describe('grouping by a field that some hits lack', () => {
  let engine: Narsil | null = null
  let server: TestServer | null = null
  let coordinator: ClusterCoordinator | null = null
  const nodes: Array<{ node: ClusterNode; transport: NodeTransport }> = []

  afterEach(async () => {
    await server?.stop()
    server = null
    await engine?.shutdown()
    engine = null
    for (const { node, transport } of nodes.splice(0).reverse()) {
      await node.shutdown().catch(() => undefined)
      await transport.shutdown().catch(() => undefined)
    }
    await coordinator?.shutdown()
    coordinator = null
  })

  it('reports null for that field in-process', async () => {
    engine = await createNarsil({ workers: { enabled: false } })
    await seeded(engine)
    const result = await engine.query(INDEX, QUERY)
    expect(answered(result.groups)).toEqual(expectedGroups())
    const absent = result.groups?.find(group => group.hits.some(hit => hit.id === 'hook-1'))
    expect(absent !== undefined && Object.hasOwn(absent.values, 'category')).toBe(true)
  })

  it('reports null for that field over HTTP', async () => {
    server = await startTestServer({}, { workers: { enabled: false } }, seeded)
    const response = await postJson<{ groups?: GroupShape[] }>(server.base, `/indexes/${INDEX}/search`, QUERY)
    expect(response.status).toBe(200)
    expect(answered(response.body.groups)).toEqual(expectedGroups())
  })

  it('reports null for that field when a cluster merges the groups of several nodes', async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    for (const nodeId of ['bench-a', 'bench-b', 'bench-c']) {
      const transport = createInMemoryTransport(nodeId, network)
      const node = await createClusterNode({
        coordinator,
        transport,
        address: nodeId,
        nodeId,
        roles: ['data', 'coordinator', 'controller'],
        engine: { workers: { enabled: false } },
      })
      await node.start()
      nodes.push({ node, transport })
    }
    const router = nodes[0].node
    await router.createIndex(INDEX, { schema: SCHEMA }, { partitionCount: PARTITION_COUNT, replicationFactor: 0 })
    const routed = clusterNodeEngine(router)
    expect((await routed.insertBatch(INDEX, DOCUMENTS)).failed).toEqual([])
    const result = await routed.query(INDEX, QUERY)
    expect(answered(result.groups as GroupShape[] | undefined)).toEqual(expectedGroups())
  }, 60_000)
})
