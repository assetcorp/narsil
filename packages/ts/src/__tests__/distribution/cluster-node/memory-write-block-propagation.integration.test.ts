import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterMemoryConfig, ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator, NodeEvent, NodeRegistration } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../errors'

const POLL_INTERVAL_MS = 50
const POLL_BUDGET_MS = 15_000
const HEARTBEAT_WAIT_MS = 25_000
const RETRY_GRACE_MS = 1_500
const GIBIBYTE = 1024 * 1024 * 1024
const MEBIBYTE = 1024 * 1024
const SCHEMA = { title: 'string', price: 'number' } as const
const ALWAYS_FULL: ClusterMemoryConfig = { blockWritesAbove: 0.001, resumeWritesBelow: 0.0005 }
const STAND_IN_CLEAR_MEMORY: NonNullable<NodeRegistration['memory']> = {
  processBytes: 100 * MEBIBYTE,
  processLimitBytes: GIBIBYTE,
  heapBytes: 50 * MEBIBYTE,
  heapLimitBytes: GIBIBYTE,
  full: false,
}

interface RealNode {
  node: ClusterNode
  transport: NodeTransport
}

const started: RealNode[] = []
const coordinators: ClusterCoordinator[] = []

afterEach(async () => {
  for (const { node, transport } of started.splice(0)) {
    await node.shutdown()
    await transport.shutdown()
  }
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

async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work
    return null
  } catch (error) {
    return error instanceof NarsilError ? error.code : String(error)
  }
}

async function startNode(options: {
  coordinator: ClusterCoordinator
  network: ReturnType<typeof createInMemoryNetwork>
  nodeId: string
  roles: Array<'data' | 'coordinator' | 'controller'>
  memory?: ClusterMemoryConfig
}): Promise<ClusterNode> {
  const transport = createInMemoryTransport(options.nodeId, options.network)
  const node = await createClusterNode({
    coordinator: options.coordinator,
    transport,
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

function withoutMemory(registration: NodeRegistration): NodeRegistration {
  const { memory: _, ...rest } = registration
  return rest
}

function blindToMemory(base: ClusterCoordinator): ClusterCoordinator {
  return {
    ...base,
    async listNodes() {
      return (await base.listNodes()).map(withoutMemory)
    },
    async watchNodes(handler: (event: NodeEvent) => void) {
      return base.watchNodes(event =>
        handler({ ...event, registration: event.registration === null ? null : withoutMemory(event.registration) }),
      )
    },
  }
}

describe('the write block reaches every node without waiting for a poll', () => {
  it('refuses a write that arrives straight after another node reports full', async () => {
    const coordinator = createInMemoryCoordinator()
    coordinators.push(coordinator)
    const network = createInMemoryNetwork()
    const entry = await startNode({
      coordinator,
      network,
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await startNode({ coordinator, network, nodeId: 'node-b', roles: ['data', 'coordinator'] })
    const standIn: NodeRegistration = {
      nodeId: 'node-f',
      address: 'node-f:9200',
      roles: ['data'],
      capacity: { memoryBytes: 8 * GIBIBYTE, cpuCores: 4, diskBytes: null },
      startedAt: '2026-10-26T09:00:00.000Z',
      version: '1.0',
      memory: STAND_IN_CLEAR_MEMORY,
    }
    await coordinator.registerNode(standIn)
    await entry.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    expect(
      await pollUntil(async () => {
        const assignment = (await coordinator.getAllocation('catalogue'))?.assignments.get(0)
        return assignment?.replicas.includes('node-f') ?? false
      }),
    ).toBe(true)

    await entry.insert('catalogue', { title: 'walnut chair', price: 120 }, 'chair-1')
    await coordinator.registerNode({
      ...standIn,
      memory: { ...STAND_IN_CLEAR_MEMORY, processBytes: 950 * MEBIBYTE, full: true },
    })
    expect(await codeOf(entry.insert('catalogue', { title: 'oak table', price: 300 }, 'table-1'))).toBe(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    )
    expect(await entry.has('catalogue', 'table-1')).toBe(false)
    expect(await entry.get('catalogue', 'chair-1')).toEqual({ title: 'walnut chair', price: 120 })
  }, 60_000)
})

describe('a full primary refuses inserts and updates that another node forwards to it', () => {
  it('refuses a forwarded insert, a forwarded batch, and a forwarded update from a node that has not seen the block', async () => {
    const coordinator = createInMemoryCoordinator()
    coordinators.push(coordinator)
    const network = createInMemoryNetwork()
    await startNode({ coordinator, network, nodeId: 'node-a', roles: ['data'], memory: ALWAYS_FULL })
    const entry = await startNode({
      coordinator: blindToMemory(coordinator),
      network,
      nodeId: 'node-b',
      roles: ['data', 'coordinator', 'controller'],
    })
    expect((await coordinator.listNodes()).find(node => node.nodeId === 'node-a')?.memory?.full).toBe(true)

    await entry.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
    expect((await coordinator.getAllocation('catalogue'))?.assignments.get(0)?.primary).toBe('node-a')

    expect(await codeOf(entry.insert('catalogue', { title: 'oak table', price: 300 }, 'table-1'))).toBe(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    )
    const batch = await entry.insertBatch('catalogue', [
      { id: 'table-2', title: 'pine table', price: 250 },
      { id: 'table-3', title: 'ash table', price: 260 },
    ])
    expect(batch.succeeded).toEqual([])
    expect(batch.failed.map(failure => [failure.docId, failure.error.code]).sort()).toEqual([
      ['table-2', ErrorCodes.CLUSTER_WRITE_BLOCKED],
      ['table-3', ErrorCodes.CLUSTER_WRITE_BLOCKED],
    ])
    expect(await codeOf(entry.update('catalogue', 'table-1', { title: 'renamed', price: 1 }))).toBe(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
    )
    for (const absent of ['table-1', 'table-2', 'table-3']) {
      expect(await entry.has('catalogue', absent)).toBe(false)
    }
    expect(await entry.countDocuments('catalogue')).toBe(0)
  }, 60_000)
})

describe('a heartbeat drops the partition sizes only when the coordinator refuses the registration as too large', () => {
  it('writes once during an outage and writes again without partition sizes after a size refusal', async () => {
    const base = createInMemoryCoordinator()
    coordinators.push(base)
    const writes: Array<{ withPartitionBytes: boolean; refusal: 'outage' | 'size' | null }> = []
    let nextRefusal: 'outage' | 'size' | null = null
    const recording: ClusterCoordinator = {
      ...base,
      async registerNode(registration) {
        const withPartitionBytes = registration.partitionBytes !== undefined
        const refusal = withPartitionBytes ? nextRefusal : null
        writes.push({ withPartitionBytes, refusal })
        if (refusal === 'outage') {
          nextRefusal = null
          throw new Error('the coordinator is unreachable')
        }
        if (refusal === 'size') {
          nextRefusal = null
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'the registration is larger than maxRequestBytes')
        }
        await base.registerNode(registration)
      },
    }
    const node = await startNode({
      coordinator: recording,
      network: createInMemoryNetwork(),
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await node.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
    await node.insert('catalogue', { title: 'walnut chair', price: 120 }, 'chair-1')

    async function refuseNextHeartbeat(refusal: 'outage' | 'size'): Promise<typeof writes> {
      const startAt = writes.length
      nextRefusal = refusal
      const deadline = Date.now() + HEARTBEAT_WAIT_MS
      while (writes.slice(startAt).every(write => write.refusal !== refusal) && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)
      }
      await sleep(RETRY_GRACE_MS)
      const since = writes.slice(startAt)
      const refusedAt = since.findIndex(write => write.refusal === refusal)
      expect(refusedAt, `no heartbeat reached the coordinator within ${HEARTBEAT_WAIT_MS} ms`).toBeGreaterThanOrEqual(0)
      return since.slice(refusedAt)
    }

    const afterOutage = await refuseNextHeartbeat('outage')
    expect(afterOutage).toEqual([{ withPartitionBytes: true, refusal: 'outage' }])

    const afterSizeRefusal = await refuseNextHeartbeat('size')
    expect(afterSizeRefusal).toEqual([
      { withPartitionBytes: true, refusal: 'size' },
      { withPartitionBytes: false, refusal: null },
    ])
    expect((await base.listNodes()).map(registration => registration.nodeId)).toEqual(['node-a'])
  }, 60_000)
})
