import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { resolvePartitionId } from '../../../../distribution/cluster-node/write-routing'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, NodeRole } from '../../../../distribution/coordinator/types'
import type { ConvergenceOracle, WriteJournal } from '../../../../distribution/transport/simulated/convergence'
import { createConvergenceOracle, createWriteJournal } from '../../../../distribution/transport/simulated/convergence'
import type { SimulatedNetwork } from '../../../../distribution/transport/simulated/network'
import { createSimulatedNetwork } from '../../../../distribution/transport/simulated/network'
import { createSimulatedTransport } from '../../../../distribution/transport/simulated/transport'
import type { NodeTransport, TransportConfig } from '../../../../distribution/transport/types'
import { createMemoryPersistence } from '../../../../persistence/memory'

const START_TIME = 1_000_000_000
const INDEX_NAME = 'products'
const TRANSPORT_TIMEOUTS: Partial<TransportConfig> = {
  connectTimeout: 500,
  requestTimeout: 500,
  replicationTimeout: 500,
  snapshotTimeout: 1_000,
}

function docIdForPartition(partitionId: number, partitionCount: number, prefix = 'doc'): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `${prefix}-${partitionId}-${i}`
    if (resolvePartitionId(candidate, partitionCount) === partitionId) {
      return candidate
    }
  }
  throw new Error(`No document id found for partition ${partitionId}`)
}

function allInSync(table: AllocationTable): boolean {
  if (table.assignments.size === 0) {
    return false
  }
  for (const assignment of table.assignments.values()) {
    if (assignment.state !== 'ACTIVE' || assignment.primary === null) {
      return false
    }
    for (const replica of assignment.replicas) {
      if (!assignment.inSyncSet.includes(replica)) {
        return false
      }
    }
  }
  return true
}

interface NodeOptions {
  logRetentionBytes?: number
  lifecycle?: boolean
}

describe('simulated cluster scenarios', () => {
  let coordinator: ClusterCoordinator
  let network: SimulatedNetwork
  let oracle: ConvergenceOracle
  let journal: WriteJournal
  let nodes: ClusterNode[]
  let transports: NodeTransport[]
  let streamChunkCounts: number[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START_TIME)
    coordinator = createInMemoryCoordinator()
    network = createSimulatedNetwork({
      seed: 42,
      startTime: START_TIME,
      advanceTimers: ms => vi.advanceTimersByTimeAsync(ms),
      faults: { latencyMinMs: 1, latencyMaxMs: 5 },
    })
    oracle = createConvergenceOracle({ network, coordinator })
    journal = createWriteJournal()
    nodes = []
    transports = []
    streamChunkCounts = []
  })

  afterEach(async () => {
    await network.scheduler.runWithDrain(async () => {
      for (const node of nodes) {
        await node.shutdown()
      }
    })
    for (const transport of transports) {
      await transport.shutdown()
    }
    await coordinator.shutdown()
    network.scheduler.dispose()
    vi.useRealTimers()
  })

  function countingTransport(base: NodeTransport): NodeTransport {
    return {
      send: (target, message) => base.send(target, message),
      stream: (target, message, handler) => {
        let chunks = 0
        return base
          .stream(target, message, chunk => {
            chunks++
            handler(chunk)
          })
          .finally(() => {
            streamChunkCounts.push(chunks)
          })
      },
      listen: handler => base.listen(handler),
      shutdown: () => base.shutdown(),
    }
  }

  async function startNode(nodeId: string, roles: NodeRole[], options: NodeOptions = {}): Promise<ClusterNode> {
    const transport = countingTransport(createSimulatedTransport(nodeId, network, TRANSPORT_TIMEOUTS))
    transports.push(transport)
    const node = await createClusterNode({
      coordinator,
      transport,
      address: `${nodeId}:9200`,
      nodeId,
      roles,
      ...(options.logRetentionBytes === undefined
        ? {}
        : { replication: { logRetentionBytes: options.logRetentionBytes } }),
      ...(options.lifecycle === true
        ? {
            engine: {
              persistence: createMemoryPersistence(),
              durability: { tier: 'snapshot' as const },
              lifecycle: {},
            },
          }
        : {}),
      onError:
        process.env.SIM_DEBUG === '1'
          ? error => console.log(`onError ${nodeId} @${network.scheduler.now - START_TIME}: ${error.message}`)
          : undefined,
    })
    nodes.push(node)
    await network.scheduler.runWithDrain(() => node.start())
    return node
  }

  async function waitForAllocation(predicate: (table: AllocationTable) => boolean): Promise<AllocationTable> {
    for (let attempt = 0; attempt < 25; attempt++) {
      await network.scheduler.runUntilQuiet({ quietMs: 500, tickMs: 50 })
      const table = await coordinator.getAllocation(INDEX_NAME)
      if (table !== null && predicate(table)) {
        return table
      }
      if (process.env.SIM_DEBUG === '1' && table !== null) {
        const shape = [...table.assignments.entries()]
          .map(
            ([id, a]) =>
              `${id}:${a.state}:p=${a.primary}:r=${a.replicas.join('+')}:s=${a.inSyncSet.join('+')}:t=${a.primaryTerm}`,
          )
          .join(' | ')
        console.log(`t=${network.scheduler.now - START_TIME} v${table.version} ${shape}`)
      }
    }
    throw new Error('Allocation never reached the expected shape')
  }

  async function startPairWithIndex(
    options: NodeOptions = {},
  ): Promise<{ nodeA: ClusterNode; nodeB: ClusterNode; table: AllocationTable }> {
    const nodeA = await startNode('node-a', ['data', 'coordinator', 'controller'], options)
    const nodeB = await startNode('node-b', ['data'], options)
    await network.scheduler.runWithDrain(() =>
      nodeA.createIndex(INDEX_NAME, { schema: { title: 'string' } }, { partitionCount: 4, replicationFactor: 1 }),
    )
    const table = await waitForAllocation(allInSync)
    return { nodeA, nodeB, table }
  }

  async function insertAcked(node: ClusterNode, docId: string, title: string): Promise<void> {
    await network.scheduler.runWithDrain(() => node.insert(INDEX_NAME, { title }, docId))
    journal.recordInsert(INDEX_NAME, docId)
  }

  it('replicates writes across both nodes and converges under simulated latency', async () => {
    const { nodeA, table } = await startPairWithIndex()

    for (const partitionId of table.assignments.keys()) {
      const docId = docIdForPartition(partitionId, table.assignments.size)
      await insertAcked(nodeA, docId, `Simulated baseline ${partitionId}`)
    }
    await network.scheduler.runUntilQuiet()

    await oracle.assertConverged(INDEX_NAME, journal)
  })

  it('keeps acknowledged writes through a partition, in-sync removal, and re-sync after healing', async () => {
    const { nodeA, table } = await startPairWithIndex()

    const partitionCount = table.assignments.size
    const primaryOnA = [...table.assignments.entries()].find(([, assignment]) => assignment.primary === 'node-a')
    if (primaryOnA === undefined) {
      throw new Error('No partition has node-a as its primary')
    }
    const [partitionId] = primaryOnA

    const baselineDocId = docIdForPartition(partitionId, partitionCount, 'baseline')
    await insertAcked(nodeA, baselineDocId, 'Written before the partition')
    await network.scheduler.runUntilQuiet()

    network.faultPolicy.addPartition('node-a', 'node-b')
    const partitionedDocId = docIdForPartition(partitionId, partitionCount, 'partitioned')
    await insertAcked(nodeA, partitionedDocId, 'Acknowledged during the partition')

    const tableDuringFault = await coordinator.getAllocation(INDEX_NAME)
    expect(tableDuringFault?.assignments.get(partitionId)?.inSyncSet).not.toContain('node-b')
    await expect(oracle.assertConverged(INDEX_NAME, journal)).rejects.toThrow(/not converged/)

    network.faultPolicy.removePartition('node-a', 'node-b')
    await waitForAllocation(allInSync)

    await oracle.assertConverged(INDEX_NAME, journal)
  }, 60_000)

  it('promotes only an in-sync replica when the node holding a primary leaves', async () => {
    await startNode('node-a', ['coordinator', 'controller'])
    const nodeB = await startNode('node-b', ['data'])
    const nodeC = await startNode('node-c', ['data'])
    await network.scheduler.runWithDrain(() =>
      nodeB.createIndex(INDEX_NAME, { schema: { title: 'string' } }, { partitionCount: 4, replicationFactor: 1 }),
    )
    const table = await waitForAllocation(allInSync)

    const partitionCount = table.assignments.size
    const primariesOnB = [...table.assignments.entries()].filter(([, assignment]) => assignment.primary === 'node-b')
    expect(primariesOnB.length).toBeGreaterThan(0)
    for (const [, assignment] of primariesOnB) {
      expect(assignment.inSyncSet).toContain('node-c')
    }

    for (const partitionId of table.assignments.keys()) {
      const docId = docIdForPartition(partitionId, partitionCount, 'before-failover')
      await insertAcked(nodeB, docId, `Written before failover ${partitionId}`)
    }
    await network.scheduler.runUntilQuiet()

    const nodeBTransport = transports[1]
    await nodeBTransport.shutdown()
    await coordinator.deregisterNode('node-b')

    const promotedTable = await waitForAllocation(current =>
      [...current.assignments.values()].every(
        assignment => assignment.primary === 'node-c' && assignment.state === 'ACTIVE',
      ),
    )

    for (const [partitionId, previous] of primariesOnB) {
      const promoted = promotedTable.assignments.get(partitionId)
      expect(promoted?.primary).toBe('node-c')
      expect(promoted?.primaryTerm).toBe(previous.primaryTerm + 1)
    }

    for (const partitionId of promotedTable.assignments.keys()) {
      const docId = docIdForPartition(partitionId, partitionCount, 'after-failover')
      await insertAcked(nodeC, docId, `Written after failover ${partitionId}`)
    }
    await network.scheduler.runUntilQuiet()

    await oracle.assertConverged(INDEX_NAME, journal)
  }, 60_000)

  it('converges once a burst of seeded random drops heals', async () => {
    const { nodeA, table } = await startPairWithIndex()
    const partitionCount = table.assignments.size

    network.faultPolicy.setDropMessageTypes(['replication.entry', 'replication.entry_batch'])
    network.faultPolicy.setDropRate(0.25)
    let acknowledged = 0
    for (let i = 0; i < 8; i++) {
      const partitionId = i % partitionCount
      const docId = docIdForPartition(partitionId, partitionCount, `chaos-${i}`)
      const outcome = await network.scheduler.runWithDrain(() =>
        nodeA.insert(INDEX_NAME, { title: `Written under drops ${i}` }, docId).then(
          () => 'acknowledged' as const,
          () => 'failed' as const,
        ),
      )
      if (outcome === 'acknowledged') {
        journal.recordInsert(INDEX_NAME, docId)
        acknowledged++
      }
    }

    network.faultPolicy.setDropRate(0)
    await network.scheduler.runUntilQuiet()

    for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
      const docId = docIdForPartition(partitionId, partitionCount, 'probe')
      await insertAcked(nodeA, docId, `Probe write after healing ${partitionId}`)
    }
    await waitForAllocation(allInSync)

    expect(acknowledged).toBeGreaterThan(0)
    await oracle.assertConverged(INDEX_NAME, journal)
  }, 60_000)

  it('continues replication sequence numbers through a close and reopen on the snapshot tier', async () => {
    const { nodeA, table } = await startPairWithIndex({ lifecycle: true })
    const partitionCount = table.assignments.size
    const primaryOnA = [...table.assignments.entries()].find(([, assignment]) => assignment.primary === 'node-a')
    if (primaryOnA === undefined) {
      throw new Error('No partition has node-a as its primary')
    }
    const [partitionId] = primaryOnA

    await insertAcked(nodeA, docIdForPartition(partitionId, partitionCount, 'before-close'), 'Written before the close')
    await network.scheduler.runUntilQuiet()

    await network.scheduler.runWithDrain(() => nodeA.close(INDEX_NAME))
    const closedStats = await network.scheduler.runWithDrain(() => nodeA.getMemoryStats())
    expect(closedStats.openIndexCount).toBe(0)

    await insertAcked(
      nodeA,
      docIdForPartition(partitionId, partitionCount, 'after-reopen'),
      'Written through the transparent reopen',
    )
    const allocationAfterReopen = await coordinator.getAllocation(INDEX_NAME)
    expect(allocationAfterReopen?.assignments.get(partitionId)?.inSyncSet).toContain('node-b')

    await network.scheduler.runUntilQuiet()
    await waitForAllocation(allInSync)
    await oracle.assertConverged(INDEX_NAME, journal)
  }, 60_000)

  it.fails('recovers replication after a close during a network partition and a reopen after healing', async () => {
    const { nodeA, table } = await startPairWithIndex({ lifecycle: true })
    const partitionCount = table.assignments.size
    const primariesOnA = [...table.assignments.entries()]
      .filter(([, assignment]) => assignment.primary === 'node-a')
      .map(([partitionId]) => partitionId)
    if (primariesOnA.length < 2) {
      throw new Error('The scenario needs two node-a primary partitions')
    }
    const [faultedPartition, steadyPartition] = primariesOnA

    await insertAcked(
      nodeA,
      docIdForPartition(faultedPartition, partitionCount, 'faulted-baseline'),
      'Written before the fault',
    )
    await insertAcked(
      nodeA,
      docIdForPartition(steadyPartition, partitionCount, 'steady-baseline'),
      'Written before the fault on the partition that stays in sync',
    )
    await network.scheduler.runUntilQuiet()

    network.faultPolicy.addPartition('node-a', 'node-b')
    await insertAcked(
      nodeA,
      docIdForPartition(faultedPartition, partitionCount, 'during-fault'),
      'Acknowledged while the replica is unreachable',
    )

    await network.scheduler.runWithDrain(() => nodeA.close(INDEX_NAME))
    const closedStats = await network.scheduler.runWithDrain(() => nodeA.getMemoryStats())
    expect(closedStats.openIndexCount).toBe(0)

    network.faultPolicy.removePartition('node-a', 'node-b')
    await waitForAllocation(allInSync)

    await insertAcked(
      nodeA,
      docIdForPartition(steadyPartition, partitionCount, 'after-reopen'),
      'Written through the transparent reopen',
    )
    const allocationAfterReopen = await coordinator.getAllocation(INDEX_NAME)
    expect(allocationAfterReopen?.assignments.get(steadyPartition)?.inSyncSet).toContain('node-b')

    await network.scheduler.runUntilQuiet()
    await waitForAllocation(allInSync)

    const reopenedStats = await network.scheduler.runWithDrain(() => nodeA.getMemoryStats())
    expect(reopenedStats.openIndexCount).toBe(1)
    expect(reopenedStats.reopenCount).toBeGreaterThan(0)
    await oracle.assertConverged(INDEX_NAME, journal)
  }, 60_000)

  it('rebuilds a replica from a multi-chunk snapshot once the log no longer holds its position', async () => {
    const { nodeA, table } = await startPairWithIndex({ logRetentionBytes: 256 })

    const partitionCount = table.assignments.size
    const primaryOnA = [...table.assignments.entries()].find(([, assignment]) => assignment.primary === 'node-a')
    if (primaryOnA === undefined) {
      throw new Error('No partition has node-a as its primary')
    }
    const [partitionId] = primaryOnA

    await insertAcked(nodeA, docIdForPartition(partitionId, partitionCount, 'pre-snapshot'), 'Written before the fault')
    await network.scheduler.runUntilQuiet()

    network.faultPolicy.addPartition('node-a', 'node-b')
    for (let i = 0; i < 12; i++) {
      const docId = docIdForPartition(partitionId, partitionCount, `beyond-retention-${i}`)
      await insertAcked(nodeA, docId, `Written past the retention window ${i}`)
    }

    streamChunkCounts.length = 0
    network.faultPolicy.removePartition('node-a', 'node-b')
    await waitForAllocation(allInSync)

    expect(Math.max(...streamChunkCounts)).toBeGreaterThan(1)
    await oracle.assertConverged(INDEX_NAME, journal)
  }, 60_000)
})
