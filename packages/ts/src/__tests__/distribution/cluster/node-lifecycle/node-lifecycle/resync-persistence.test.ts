import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataNodeLifecycle } from '../../../../../distribution/cluster/node-lifecycle'
import type { DataNodeHandle } from '../../../../../distribution/cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../../../../../distribution/cluster/node-lifecycle/types'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../../distribution/transport'
import { flushPromises, makeAllocationTable, makeAssignment, makeNode } from './fixtures'

const LONGEST_ACCEPTABLE_RESYNC_GAP_MS = 10_000
const RETRY_CYCLE_MS =
  DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryMaxMs * (DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries + 2)

describe('replica resync while the assignment stands', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let lifecycle: DataNodeHandle | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    nodeTransport = createInMemoryTransport('data-1', network)
  })

  afterEach(async () => {
    if (lifecycle !== undefined) {
      await lifecycle.shutdown()
      lifecycle = undefined
    }
    await nodeTransport.shutdown()
    await coordinator.shutdown()
    vi.useRealTimers()
  })

  function createLifecycle(
    onBootstrapPartition: (indexName: string, partitionId: number, primaryNodeId: string) => Promise<boolean>,
  ): DataNodeHandle {
    lifecycle = createDataNodeLifecycle({
      registration: makeNode('data-1'),
      coordinator,
      transport: nodeTransport,
      knownIndexNames: ['products'],
      bootstrapRetryBaseMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryBaseMs,
      bootstrapRetryMaxMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryMaxMs,
      bootstrapMaxRetries: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries,
      allocationDebounceMs: DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs,
      nodeHeartbeatIntervalMs: DEFAULT_NODE_LIFECYCLE_CONFIG.nodeHeartbeatIntervalMs,
      onBootstrapPartition,
    })
    return lifecycle
  }

  async function seedActiveReplicaOutOfSync(): Promise<void> {
    await coordinator.registerNode(makeNode('primary-node'))
    const assignments = new Map<number, PartitionAssignment>()
    assignments.set(
      0,
      makeAssignment({
        primary: 'primary-node',
        replicas: ['data-1'],
        inSyncSet: ['primary-node'],
        state: 'ACTIVE',
      }),
    )
    await coordinator.putAllocation('products', makeAllocationTable('products', assignments))
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
    await flushPromises()
  }

  it('keeps attempting the sync protocol while the primary stays unreachable', async () => {
    await seedActiveReplicaOutOfSync()
    const attempts = vi.fn().mockResolvedValue(false)

    const handle = createLifecycle(attempts)
    await handle.join()
    await advance(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)

    await advance(RETRY_CYCLE_MS)
    const afterFirstCycle = attempts.mock.calls.length
    expect(afterFirstCycle).toBeGreaterThan(DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries)

    await advance(RETRY_CYCLE_MS)
    expect(attempts.mock.calls.length).toBeGreaterThan(afterFirstCycle)
  })

  it('retries often enough to catch a primary that becomes reachable again', async () => {
    await seedActiveReplicaOutOfSync()
    const attemptTimes: number[] = []
    const attempts = vi.fn().mockImplementation(async () => {
      attemptTimes.push(Date.now())
      return false
    })

    const handle = createLifecycle(attempts)
    await handle.join()
    await advance(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
    await advance(RETRY_CYCLE_MS * 2)

    expect(attemptTimes.length).toBeGreaterThan(DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries)
    const longestGap = attemptTimes
      .slice(1)
      .reduce((longest, at, index) => Math.max(longest, at - attemptTimes[index]), 0)
    expect(longestGap).toBeLessThanOrEqual(LONGEST_ACCEPTABLE_RESYNC_GAP_MS)
  })

  it('stops attempting once the replica has rejoined the in-sync set', async () => {
    await seedActiveReplicaOutOfSync()
    const attempts = vi.fn().mockResolvedValue(false)

    const handle = createLifecycle(attempts)
    await handle.join()
    await advance(DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs + 10)
    await advance(RETRY_CYCLE_MS)

    const table = await coordinator.getAllocation('products')
    if (table === null) throw new Error('allocation missing')
    const assignment = table.assignments.get(0)
    if (assignment === undefined) throw new Error('assignment missing')
    const assignments = new Map<number, PartitionAssignment>()
    assignments.set(0, { ...assignment, inSyncSet: ['primary-node', 'data-1'] })
    await coordinator.putAllocation(
      'products',
      makeAllocationTable('products', assignments, table.version + 1),
      table.version,
    )

    await advance(RETRY_CYCLE_MS)
    const settled = attempts.mock.calls.length
    await advance(RETRY_CYCLE_MS)

    expect(attempts.mock.calls.length).toBe(settled)
  })
})
