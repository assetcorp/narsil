import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { isPagedSegmentFile } from '../../../persistence/paged/verify'
import { waitForSettledReplica } from './cluster-harness'

const INDEX_NAME = 'listings'
const DOCUMENT_TOTAL = 300

describe('a cluster index that stores its text on disk', () => {
  let root: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const nodes: ClusterNode[] = []

  async function startNode(nodeId: string): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: `${nodeId}:9200`,
      nodeId,
      roles: ['data', 'coordinator', 'controller'],
      engine: { workers: { enabled: false }, durability: { directory: join(root, nodeId) } },
    })
    nodes.push(node)
    await node.start()
    return node
  }

  async function pagedSegmentsOn(nodeId: string): Promise<number> {
    const directory = createDurableDirectory(join(root, nodeId))
    let paged = 0
    for (const key of await directory.list(`${INDEX_NAME}/segments/`)) {
      if (await isPagedSegmentFile(directory, key)) paged += 1
    }
    return paged
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-cluster-disk-text-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    for (const node of nodes.splice(0)) await node.shutdown()
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps the setting on a node that receives a copy later and answers from its files', async () => {
    const first = await startNode('node-a')
    await first.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' }, textStorage: 'disk' },
      { partitionCount: 2, replicationFactor: 1 },
    )
    const documents = Array.from({ length: DOCUMENT_TOTAL }, (_, position) => ({
      id: `listing-${position}`,
      title: `mortgage code${position}`,
    }))
    expect((await first.insertBatch(INDEX_NAME, documents)).failed).toEqual([])
    await first.checkpoint(INDEX_NAME)
    expect(await pagedSegmentsOn('node-a')).toBeGreaterThan(0)

    const second = await startNode('node-b')
    await waitForSettledReplica(coordinator, INDEX_NAME, 'node-b')
    await second.checkpoint(INDEX_NAME)
    expect(await pagedSegmentsOn('node-b')).toBeGreaterThan(0)

    for (const position of [0, 17, 299]) {
      const page = await second.query(INDEX_NAME, { term: `code${position}` })
      expect(page.hits.map(hit => hit.id)).toEqual([`listing-${position}`])
    }
    expect((await second.getStats(INDEX_NAME)).documentCount).toBe(DOCUMENT_TOTAL)
  }, 60_000)
})
