import { setTimeout as sleep } from 'node:timers/promises'
import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterMemoryConfig, ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createForwardBatchMessage, createForwardMessage } from '../../../distribution/replication/codec'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import { type FaultyTransport, faultyTransport } from './acknowledged-writes/harness'

const POLL_INTERVAL_MS = 50
const POLL_BUDGET_MS = 15_000
const SCHEMA = { title: 'string', price: 'number' } as const
const TINY_IN_FLIGHT: ClusterMemoryConfig = { inFlightWriteFraction: 0.000_001 }
const LARGE_TITLE_CHARACTERS = 200_000
const LOOPED_DOCUMENT_BUDGET_MS = 1_000

interface RealNode {
  node: ClusterNode
  transport: NodeTransport
}

const started: RealNode[] = []
const peers: NodeTransport[] = []
const coordinators: ClusterCoordinator[] = []

afterEach(async () => {
  for (const { node, transport } of started.splice(0)) {
    await node.shutdown()
    await transport.shutdown()
  }
  for (const peer of peers.splice(0)) await peer.shutdown()
  for (const coordinator of coordinators.splice(0)) await coordinator.shutdown()
})

async function pollUntil(predicate: () => Promise<boolean>): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

async function refusalOf(work: Promise<unknown>): Promise<NarsilError | null> {
  try {
    await work
    return null
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
}

async function startNode(options: {
  coordinator: ClusterCoordinator
  network: ReturnType<typeof createInMemoryNetwork>
  nodeId: string
  roles: Array<'data' | 'coordinator' | 'controller'>
  memory?: ClusterMemoryConfig
  wrapTransport?: (transport: NodeTransport) => NodeTransport
}): Promise<ClusterNode> {
  const transport = createInMemoryTransport(options.nodeId, options.network)
  const node = await createClusterNode({
    coordinator: options.coordinator,
    transport: options.wrapTransport?.(transport) ?? transport,
    address: `${options.nodeId}:9200`,
    nodeId: options.nodeId,
    roles: options.roles,
    engine: { workers: { enabled: false } },
    memory: options.memory,
  })
  started.push({ node, transport })
  await node.start()
  return node
}

function largeTable(serial: number): { title: string; price: number } {
  return { title: `oak table ${serial} ${'w'.repeat(LARGE_TITLE_CHARACTERS)}`, price: serial }
}

function expectInFlightRefusal(error: NarsilError | null, nodeId: string): void {
  expect(error?.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
  expect(error?.details).toMatchObject({ reason: 'write_bytes_in_flight', indexName: 'catalogue', nodeId })
  const details = error?.details ?? {}
  expect(Number(details.inFlightBytes)).toBeGreaterThan(LARGE_TITLE_CHARACTERS)
  expect(Number(details.requestBytes)).toBeGreaterThan(LARGE_TITLE_CHARACTERS)
  expect(Number(details.limitBytes)).toBeLessThan(LARGE_TITLE_CHARACTERS)
}

function expectForwardedInFlightRefusal(error: NarsilError | null): void {
  expect(error?.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
  expect(error?.message).toContain("Node 'node-a' refuses this write to index 'catalogue'")
  expect(error?.details).toMatchObject({
    reason: 'write_bytes_in_flight',
    indexName: 'catalogue',
    nodeId: 'node-a',
    primaryNodeId: 'node-a',
  })
  expect(Number(error?.details.requestBytes)).toBeGreaterThan(LARGE_TITLE_CHARACTERS)
}

describe('a cluster node refuses inserts and updates whose documents would pass its bound on write bytes in flight', () => {
  it('accepts a large insert on an idle node, refuses a large insert, batch, and update sent while it is in progress, and lets small writes and removes through', async () => {
    const coordinator = createInMemoryCoordinator()
    coordinators.push(coordinator)
    const node = await startNode({
      coordinator,
      network: createInMemoryNetwork(),
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      memory: TINY_IN_FLIGHT,
    })
    await node.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
    const expected = new Map<string, { title: string; price: number }>()

    await node.insert('catalogue', { title: 'walnut chair', price: 120 }, 'chair-1')
    expected.set('chair-1', { title: 'walnut chair', price: 120 })
    await node.insertBatch('catalogue', [{ id: 'chair-2', title: 'beech chair', price: 90 }])
    expected.set('chair-2', { title: 'beech chair', price: 90 })

    const idleWrite = node.insert('catalogue', largeTable(0), 'table-0')
    const refusals = [
      refusalOf(node.insert('catalogue', largeTable(1), 'table-1')),
      refusalOf(node.insertBatch('catalogue', [{ id: 'table-2', ...largeTable(2) }])),
      refusalOf(node.update('catalogue', 'chair-1', largeTable(3))),
    ]
    for (const refusal of await Promise.all(refusals)) expectInFlightRefusal(refusal, 'node-a')
    expect(await idleWrite).toBe('table-0')
    expected.set('table-0', largeTable(0))

    await node.remove('catalogue', 'chair-2')
    expected.delete('chair-2')
    await node.insert('catalogue', { title: 'pine chair', price: 70 }, 'chair-3')
    expected.set('chair-3', { title: 'pine chair', price: 70 })

    for (const absent of ['table-1', 'table-2', 'chair-2']) {
      expect(await node.has('catalogue', absent)).toBe(false)
    }
    for (const [id, document] of expected) {
      expect(await node.get('catalogue', id)).toEqual(document)
    }
    expect(await node.countDocuments('catalogue')).toBe(expected.size)

    const looped: Record<string, unknown> = { title: 'looped chair', price: 10 }
    looped.self = looped
    const loopedAt = Date.now()
    const loopedOutcome = await node.insert('catalogue', looped, 'looped-1').then(
      () => 'stored',
      (error: unknown) => (error instanceof NarsilError ? error.code : String(error)),
    )
    expect(loopedOutcome).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
    expect(Date.now() - loopedAt).toBeLessThan(LOOPED_DOCUMENT_BUDGET_MS)
    expect(await node.has('catalogue', 'looped-1')).toBe(false)
  }, 60_000)

  it('refuses a large write that another node forwards to the primary while a write waits there on its replica, and lets a forwarded remove through', async () => {
    const coordinator = createInMemoryCoordinator()
    coordinators.push(coordinator)
    const network = createInMemoryNetwork()
    const wrapped: { primary: FaultyTransport | null } = { primary: null }
    await startNode({
      coordinator,
      network,
      nodeId: 'node-a',
      roles: ['data'],
      memory: TINY_IN_FLIGHT,
      wrapTransport: transport => {
        const faulty = faultyTransport(transport, 'node-a')
        wrapped.primary = faulty
        return faulty
      },
    })
    const entry = await startNode({
      coordinator,
      network,
      nodeId: 'node-b',
      roles: ['data', 'coordinator', 'controller'],
    })
    await entry.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    expect(
      await pollUntil(async () => {
        const assignment = (await coordinator.getAllocation('catalogue'))?.assignments.get(0)
        return assignment?.primary === 'node-a' && (assignment?.inSyncSet.includes('node-b') ?? false)
      }),
    ).toBe(true)
    const primaryTransport = wrapped.primary
    if (primaryTransport === null) throw new Error('node-a started without its transport')

    await entry.insert('catalogue', { title: 'walnut chair', price: 120 }, 'chair-1')
    const replication = primaryTransport.holdWhen(
      (target, message) => target === 'node-b' && message.type.startsWith('replication.entry'),
    )
    const idleWrite = entry.insert('catalogue', largeTable(0), 'table-0')
    expect(await pollUntil(async () => replication.count() > 0)).toBe(true)
    expectForwardedInFlightRefusal(await refusalOf(entry.insert('catalogue', largeTable(1), 'table-1')))
    expectForwardedInFlightRefusal(await refusalOf(entry.update('catalogue', 'chair-1', largeTable(2))))

    const batch = await entry.insertBatch('catalogue', [
      { id: 'table-2', ...largeTable(3) },
      { id: 'table-3', ...largeTable(4) },
    ])
    expect(batch.succeeded).toEqual([])
    expect(batch.failed.map(failure => failure.docId).sort()).toEqual(['table-2', 'table-3'])
    for (const failure of batch.failed) expectForwardedInFlightRefusal(failure.error)

    const peer = createInMemoryTransport('peer-x', network)
    peers.push(peer)
    const fieldsOnly = { document: null, updateFields: { title: largeTable(5).title } }
    const forwarded = await peer.send(
      'node-a',
      createForwardMessage(
        { indexName: 'catalogue', documentId: 'chair-1', operation: 'update', ...fieldsOnly },
        'peer-x',
      ),
    )
    expect(decode(forwarded.payload)).toMatchObject({ code: ErrorCodes.CLUSTER_WRITE_BLOCKED })
    const forwardedBatch = await peer.send(
      'node-a',
      createForwardBatchMessage(
        {
          indexName: 'catalogue',
          operations: [
            { documentId: 'chair-1', operation: 'update', ...fieldsOnly },
            { documentId: 'chair-1', operation: 'update', ...fieldsOnly },
          ],
        },
        'peer-x',
      ),
    )
    const batchReply = decode(forwardedBatch.payload) as { results?: Array<{ errorCode?: unknown }> }
    expect(batchReply.results?.map(result => result.errorCode)).toEqual([
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    ])
    expect(await entry.get('catalogue', 'chair-1')).toEqual({ title: 'walnut chair', price: 120 })

    replication.release()
    expect(await idleWrite).toBe('table-0')
    const small = await entry.insertBatch('catalogue', [{ id: 'chair-2', title: 'beech chair', price: 90 }])
    expect(small.succeeded).toEqual(['chair-2'])
    await entry.remove('catalogue', 'chair-1')

    expect(await entry.has('catalogue', 'chair-1')).toBe(false)
    for (const absent of ['table-1', 'table-2', 'table-3']) {
      expect(await entry.has('catalogue', absent)).toBe(false)
    }
    expect(await entry.get('catalogue', 'chair-2')).toEqual({ id: 'chair-2', title: 'beech chair', price: 90 })
    expect(await entry.get('catalogue', 'table-0')).toEqual(largeTable(0))
    expect(await entry.countDocuments('catalogue')).toBe(2)
  }, 60_000)

  it('applies a replicated entry on a replica whatever its bound', async () => {
    const coordinator = createInMemoryCoordinator()
    coordinators.push(coordinator)
    const network = createInMemoryNetwork()
    const primary = await startNode({
      coordinator,
      network,
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    const replica = await startNode({ coordinator, network, nodeId: 'node-b', roles: ['data'], memory: TINY_IN_FLIGHT })
    await primary.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    expect(
      await pollUntil(async () => {
        const assignment = (await coordinator.getAllocation('catalogue'))?.assignments.get(0)
        return assignment?.primary === 'node-a' && (assignment?.inSyncSet.includes('node-b') ?? false)
      }),
    ).toBe(true)

    const emptyReplicaBytes = (await replica.getMemoryStats()).estimatedIndexBytes
    await primary.insert('catalogue', largeTable(1), 'table-1')
    expect(await pollUntil(async () => (await replica.getMemoryStats()).estimatedIndexBytes > emptyReplicaBytes)).toBe(
      true,
    )
    const assignment = (await coordinator.getAllocation('catalogue'))?.assignments.get(0)
    expect(assignment?.inSyncSet).toContain('node-b')
  }, 60_000)
})
