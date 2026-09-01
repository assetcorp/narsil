import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { seedReopenedPrimaryLogs } from '../../../distribution/cluster-node/local-replication'
import { deleteIndexReplicationLogs, getReplicationLog } from '../../../distribution/cluster-node/replication-logs'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'

describe('cluster-node index lifecycle', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode | null
  let directory: string

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    directory = await mkdtemp(join(tmpdir(), 'narsil-cluster-lifecycle-'))
    node = null
  })

  afterEach(async () => {
    await node?.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  it('closes only the local copy and reopens it for the next cluster read', async () => {
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory }, lifecycle: {} },
    })
    await node.start()
    await node.createIndex('products', { schema: { title: 'string' } })
    await node.insert('products', { title: 'Desk lamp' }, 'lamp')

    await node.close('products')

    expect((await node.getMemoryStats()).openIndexCount).toBe(0)
    expect(await node.countDocuments('products')).toBe(1)
    expect((await node.getMemoryStats()).openIndexCount).toBe(1)
  })

  it('removes only the closed index replication logs', () => {
    const logs = new Map()
    getReplicationLog(logs, 'products', 0)
    getReplicationLog(logs, 'products-archive', 0)

    deleteIndexReplicationLogs(logs, 'products')

    expect([...logs.keys()]).toEqual(['products-archive:0'])
  })

  it('resumes a reopened primary log above its durable and committed floors', async () => {
    await coordinator.putAllocation('products', {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments: new Map([
        [
          0,
          {
            primary: 'node-a',
            replicas: ['node-a'],
            inSyncSet: ['node-a'],
            state: 'ACTIVE',
            primaryTerm: 3,
            commitPoint: 7,
          },
        ],
      ]),
    })
    const logs = new Map()

    await seedReopenedPrimaryLogs({
      indexName: 'products',
      nodeId: 'node-a',
      engine: {
        heldPartitionsOf: () => [0],
        highestPersistedSeqNoOf: () => 9,
      },
      coordinator,
      replicationLogs: logs,
    })
    const entry = getReplicationLog(logs, 'products', 0).append({
      primaryTerm: 3,
      operation: 'DELETE',
      partitionId: 0,
      indexName: 'products',
      documentId: 'lamp',
      document: null,
    })

    expect(entry.seqNo).toBe(10)
  })
})
