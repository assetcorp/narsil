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
import { type NodeTransport, ReplicationMessageTypes } from '../../../distribution/transport/types'
import { bodyOf, checkpointFileBytes, logFileBytes } from '../../persistence/durability/saved-size-oracle'
import { waitForSettledReplica } from './cluster-harness'

const INDEX = 'articles'
const DATA_NODES = ['node-a', 'node-b']
const CONTROLLER = 'node-c'
const DOCUMENTS = 120

describe('the saved size of every copy while a replica is outside the in-sync set', () => {
  let root: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let holdAdmissions = false
  const nodes = new Map<string, ClusterNode>()

  function directoryOf(nodeId: string): string {
    return join(root, nodeId)
  }

  function controllerTransport(): NodeTransport {
    const inner = createInMemoryTransport(CONTROLLER, network)
    return {
      ...inner,
      listen: handler =>
        inner.listen((message, respond) => {
          if (holdAdmissions && message.type === ReplicationMessageTypes.INSYNC_ADD) return
          return handler(message, respond)
        }),
    }
  }

  async function startNode(nodeId: string, roles: Array<'data' | 'coordinator' | 'controller'>): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: nodeId === CONTROLLER ? controllerTransport() : createInMemoryTransport(nodeId, network),
      address: `${nodeId}:9200`,
      nodeId,
      roles,
      engine: {
        workers: { enabled: false },
        durability: { directory: directoryOf(nodeId), checkpointIntervalMs: 0 },
      },
    })
    nodes.set(nodeId, node)
    await node.start()
    return node
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-every-copy-sizes-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    holdAdmissions = false
  })

  afterEach(async () => {
    for (const node of nodes.values()) await node.shutdown()
    nodes.clear()
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('adds up the files of every copy, the copy outside the in-sync set included', async () => {
    await startNode(CONTROLLER, ['controller'])
    const first = await startNode('node-a', ['data', 'coordinator'])
    await first.createIndex(
      INDEX,
      { schema: { title: 'string', body: 'string' } },
      { partitionCount: 2, replicationFactor: 1 },
    )
    await startNode('node-b', ['data', 'coordinator'])
    const settled = await waitForSettledReplica(coordinator, INDEX, 'node-b')
    const documents = Array.from({ length: DOCUMENTS }, (_, at) => ({
      id: `article-${at}`,
      title: `title ${at}`,
      body: bodyOf(at, 200),
    }))
    expect((await first.insertBatch(INDEX, documents)).failed).toEqual([])
    for (const node of [first, nodes.get('node-b')]) await node?.checkpoint(INDEX)

    const ledByA = [...settled.assignments].find(([, settledAssignment]) => settledAssignment.primary === 'node-a')
    if (ledByA === undefined) throw new Error('node-a leads no partition')
    const [partitionId] = ledByA
    holdAdmissions = true
    const current = await coordinator.getAllocation(INDEX)
    const assignment = current?.assignments.get(partitionId)
    if (current === null || assignment === undefined) throw new Error('the allocation is gone')
    expect(assignment.inSyncSet).toContain('node-b')
    const assignments = new Map(current.assignments)
    assignments.set(partitionId, { ...assignment, inSyncSet: assignment.inSyncSet.filter(id => id !== 'node-b') })
    await coordinator.putAllocation(INDEX, { ...current, version: current.version + 1, assignments })

    const stats = await first.getStats(INDEX)
    expect(stats.documentCount).toBe(DOCUMENTS)
    expect(stats.savedBytesOfEveryCopy).toBe(
      DATA_NODES.reduce((total, nodeId) => total + checkpointFileBytes(directoryOf(nodeId), INDEX), 0),
    )
    expect(stats.logBytesOfEveryCopy).toBe(
      DATA_NODES.reduce((total, nodeId) => total + logFileBytes(directoryOf(nodeId), INDEX), 0),
    )
    const table = await coordinator.getAllocation(INDEX)
    expect(table?.assignments.get(partitionId)?.inSyncSet).not.toContain('node-b')
  }, 120_000)
})
