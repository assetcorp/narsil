import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { ClusterMessageTypes, type NodeTransport } from '../../../distribution/transport/types'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import { waitForActiveAllocation } from '../cluster-node/cluster-harness'

const INDEX = 'ledger'
const PRIMARY = 'node-a'
const CONTROLLER = 'node-c'
const DOCUMENTS = 50

describe('a partition backup sent to a primary whose partition is INITIALISING', () => {
  let root: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let dropBootstrapReports = false
  const nodes: ClusterNode[] = []
  const transports: NodeTransport[] = []

  function controllerTransport(): NodeTransport {
    const inner = createInMemoryTransport(CONTROLLER, network)
    return {
      ...inner,
      listen: handler =>
        inner.listen((message, respond) => {
          if (dropBootstrapReports && message.type === ClusterMessageTypes.BOOTSTRAP_COMPLETE) return
          return handler(message, respond)
        }),
    }
  }

  async function startNode(
    nodeId: string,
    transport: NodeTransport,
    roles: Array<'data' | 'coordinator' | 'controller'>,
  ) {
    const node = await createClusterNode({
      coordinator,
      transport,
      address: `${nodeId}:9200`,
      nodeId,
      roles,
      backups: { store: createFilesystemPersistence({ directory: join(root, 'store') }), keyPrefix: 'backups' },
      engine: { workers: { enabled: false }, durability: { directory: join(root, nodeId), mode: 'sync' } },
    })
    nodes.push(node)
    await node.start()
    return node
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-initialising-backup-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    dropBootstrapReports = false
  })

  afterEach(async () => {
    for (const node of nodes.reverse()) await node.shutdown()
    nodes.length = 0
    for (const transport of transports) await transport.shutdown()
    transports.length = 0
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('refuses with QUERY_NO_ACTIVE_REPLICA, so no backup of a copy that is still building can be taken', async () => {
    await startNode(CONTROLLER, controllerTransport(), ['controller', 'coordinator'])
    const primary = await startNode(PRIMARY, createInMemoryTransport(PRIMARY, network), ['data', 'coordinator'])
    await primary.createIndex(INDEX, { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 0 })
    const active = await waitForActiveAllocation(coordinator, INDEX)
    const documents = Array.from({ length: DOCUMENTS }, (_, at) => ({ id: `entry-${at}`, title: `entry ${at}` }))
    expect((await primary.insertBatch(INDEX, documents)).failed).toEqual([])

    dropBootstrapReports = true
    const assignment = active.assignments.get(0)
    if (assignment === undefined) throw new Error('the index has no partition 0')
    expect(assignment.primary).toBe(PRIMARY)
    const current = await coordinator.getAllocation(INDEX)
    if (current === null) throw new Error('the allocation is gone')
    await coordinator.putAllocation(INDEX, {
      ...current,
      version: current.version + 1,
      assignments: new Map([[0, { ...assignment, state: 'INITIALISING' }]]),
    })

    const peer = createInMemoryTransport('peer', network)
    transports.push(peer)
    const reply = await peer.send(PRIMARY, {
      type: ClusterMessageTypes.BACKUP_PARTITION,
      sourceId: 'peer',
      requestId: 'backup-of-initialising-partition',
      payload: encode({ jobId: 'job-1', backupName: 'nightly', indexName: INDEX, partitionId: 0 }),
    })
    const body = decode(reply.payload) as Record<string, unknown>
    expect(body.error).toBe(true)
    expect(body.code).toBe('QUERY_NO_ACTIVE_REPLICA')
    expect((await coordinator.getAllocation(INDEX))?.assignments.get(0)?.state).toBe('INITIALISING')
  }, 60_000)
})
