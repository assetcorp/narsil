import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'

const INDEX_NAME = 'shop'
const WRITE_TOTAL = 12

describe('a partition recovered from unassigned taking a replica back', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let holderDirectory: string
  let replicaDirectory: string
  let holder: ClusterNode | undefined
  let replica: ClusterNode | undefined

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    holderDirectory = await mkdtemp(join(tmpdir(), 'narsil-numbering-holder-'))
    replicaDirectory = await mkdtemp(join(tmpdir(), 'narsil-numbering-replica-'))
  })

  afterEach(async () => {
    await holder?.shutdown()
    await replica?.shutdown()
    holder = undefined
    replica = undefined
    await coordinator.shutdown()
    await rm(holderDirectory, { recursive: true, force: true })
    await rm(replicaDirectory, { recursive: true, force: true })
  })

  async function startHolder(): Promise<ClusterNode> {
    const started = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('node-a', network),
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory: holderDirectory } },
    })
    await started.start()
    return started
  }

  async function startReplica(): Promise<ClusterNode> {
    const started = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('node-b', network),
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
      engine: { durability: { directory: replicaDirectory } },
    })
    await started.start()
    return started
  }

  async function waitForAllocation(settled: (table: AllocationTable) => boolean): Promise<AllocationTable> {
    let settle: ((table: AllocationTable) => void) | undefined
    const reached = new Promise<AllocationTable>(resolve => {
      settle = resolve
    })
    const unwatch = await coordinator.watchAllocation(event => {
      if (event.indexName === INDEX_NAME && settled(event.table)) settle?.(event.table)
    })
    try {
      const current = await coordinator.getAllocation(INDEX_NAME)
      if (current !== null && settled(current)) return current
      return await reached
    } finally {
      unwatch()
    }
  }

  async function markEveryPartitionUnassigned(): Promise<void> {
    const served = await coordinator.getAllocation(INDEX_NAME)
    if (served === null) {
      throw new Error('the index has no allocation')
    }
    const orphaned = new Map<number, PartitionAssignment>()
    for (const [partitionId, entry] of served.assignments) {
      orphaned.set(partitionId, {
        ...entry,
        primary: null,
        replicas: [],
        inSyncSet: [],
        lastHolders: ['node-a', 'node-b'],
        state: 'UNASSIGNED',
      })
    }
    expect(
      await coordinator.putAllocation(
        INDEX_NAME,
        { ...served, version: served.version + 1, assignments: orphaned },
        served.version,
      ),
    ).toBe(true)
  }

  it('takes the replica back into the in-sync set', async () => {
    holder = await startHolder()
    await holder.createIndex(INDEX_NAME, { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 1 })
    replica = await startReplica()
    await waitForAllocation(table => [...table.assignments.values()].every(e => e.inSyncSet.includes('node-b')))

    await replica.shutdown()
    replica = undefined
    for (let index = 0; index < WRITE_TOTAL; index += 1) {
      await holder.insert(INDEX_NAME, { title: `portable grinder ${index}` }, `item-${index}`)
    }
    replica = await startReplica()

    const raised = await waitForAllocation(table => [...table.assignments.values()].every(e => e.commitPoint > 0))
    expect([...raised.assignments.values()].every(entry => entry.commitPoint >= WRITE_TOTAL)).toBe(true)

    await holder.checkpoint(INDEX_NAME)
    await markEveryPartitionUnassigned()
    await replica.shutdown()
    replica = undefined
    await holder.shutdown()

    holder = await startHolder()
    await waitForAllocation(table =>
      [...table.assignments.values()].every(entry => entry.state === 'ACTIVE' && entry.primary === 'node-a'),
    )
    replica = await startReplica()

    const rejoined = await waitForAllocation(table =>
      [...table.assignments.values()].every(entry => entry.inSyncSet.includes('node-b')),
    )
    expect([...rejoined.assignments.values()].every(entry => entry.inSyncSet.includes('node-b'))).toBe(true)
  }, 180_000)
})
