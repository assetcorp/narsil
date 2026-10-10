import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { ErrorCodes } from '../../../errors'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { PATTERN_INDEX, patternConfig, patternDocuments, referenceIds } from '../../filters/pattern/fixtures'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000
const PARTITION_COUNT = 4
const NODE_WORK_CAP = 2_000
const LONG_CODE: AnyDocument = { id: 'long', body: 'record', plain: 'p', code: 'x'.repeat(5_000) }

const PROBES: Array<[string, FieldFilter]> = [
  ['code', { contains: 'inv', caseFold: true }],
  ['code', { eq: 'strasse', caseFold: true }],
  ['code', { startsWith: 'conn', caseFold: true }],
  ['code', { endsWith: 'smile 😀' }],
  ['code', { ne: 'abcabc' }],
  ['title', { contains: 'error', caseFold: true }],
  ['tags', { in: ['beta', 'gamma'] }],
  ['tags', { nin: ['beta'] }],
]

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

describe('a pattern test in a cluster', () => {
  let coordinator: ClusterCoordinator
  let nodes: ClusterNode[]
  let transports: NodeTransport[]
  let router: ClusterNode
  const documents = [...patternDocuments(), LONG_CODE]

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    nodes = []
    transports = []

    for (const nodeId of ['holder-1', 'holder-2']) {
      const transport = createInMemoryTransport(nodeId, network)
      transports.push(transport)
      const node = await createClusterNode({
        coordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data'],
        engine: { workers: { enabled: false }, patternWorkCap: NODE_WORK_CAP },
      })
      await node.start()
      nodes.push(node)
    }

    const routerTransport = createInMemoryTransport('router', network)
    transports.push(routerTransport)
    router = await createClusterNode({
      coordinator,
      transport: routerTransport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    await router.start()
    nodes.push(router)

    const registered = await pollUntil(
      async () => (await coordinator.listNodes()).filter(node => node.roles.includes('data')).length === 2,
    )
    expect(registered).toBe(true)

    await router.createIndex(PATTERN_INDEX, patternConfig, { partitionCount: PARTITION_COUNT, replicationFactor: 0 })
    const active = await pollUntil(async () => {
      const table = await coordinator.getAllocation(PATTERN_INDEX)
      if (table === null || table.assignments.size === 0) return false
      return [...table.assignments.values()].every(assignment => assignment.state === 'ACTIVE')
    })
    expect(active).toBe(true)

    const inserted = await router.insertBatch(PATTERN_INDEX, documents)
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    for (const node of nodes) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  it('returns the same documents as one engine', async () => {
    for (const [field, filter] of PROBES) {
      const result = await router.query(PATTERN_INDEX, {
        term: 'record',
        filters: { fields: { [field]: filter } },
        limit: 100,
      })
      expect(result.hits.map(hit => hit.id).sort(), JSON.stringify(filter)).toEqual(
        referenceIds(documents, field, filter),
      )
    }
  }, 30_000)

  it('fails the whole query when one node passes its work cap', async () => {
    await expect(
      router.query(PATTERN_INDEX, { term: 'record', filters: { fields: { code: { contains: 'zz' } } } }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED })
  }, 30_000)
})
