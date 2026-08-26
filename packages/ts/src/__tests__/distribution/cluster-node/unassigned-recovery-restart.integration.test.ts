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
const NODE_ID = 'node-a'
const DOCUMENT_TOTAL = 24
const ALLOCATION_POLL_INTERVAL_MS = 25
const ALLOCATION_POLL_ATTEMPTS = 1_200

function shopDocuments(): Array<Record<string, unknown>> {
  return Array.from({ length: DOCUMENT_TOTAL }, (_, index) => ({
    id: `item-${index}`,
    title: `portable grinder ${index}`,
    price: index,
  }))
}

describe('a node restarting to find every partition it held unassigned', () => {
  let directory: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let node: ClusterNode | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-unassigned-restart-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    if (node !== undefined) {
      await node.shutdown()
      node = undefined
    }
    await coordinator.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  async function startNode(): Promise<ClusterNode> {
    const started = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport(NODE_ID, network),
      address: 'node-a:9200',
      nodeId: NODE_ID,
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory } },
    })
    await started.start()
    return started
  }

  async function waitForAllocation(settled: (table: AllocationTable) => boolean): Promise<AllocationTable> {
    let last: AllocationTable | null = null
    for (let attempt = 0; attempt < ALLOCATION_POLL_ATTEMPTS; attempt += 1) {
      last = await coordinator.getAllocation(INDEX_NAME)
      if (last !== null && settled(last)) {
        return last
      }
      await new Promise(resolve => setTimeout(resolve, ALLOCATION_POLL_INTERVAL_MS))
    }
    const seen = [...(last?.assignments.values() ?? [])].map(
      entry => `${entry.state}/${entry.primary}/${entry.unassignedReason ?? 'no reason'}`,
    )
    throw new Error(`the allocation never reached the expected shape, last seen: ${seen.join(', ')}`)
  }

  async function markEveryPartitionUnassigned(): Promise<void> {
    const served = await waitForAllocation(table =>
      [...table.assignments.values()].every(entry => entry.state === 'ACTIVE' && entry.primary !== null),
    )
    const orphaned = new Map<number, PartitionAssignment>()
    for (const [partitionId, assignment] of served.assignments) {
      orphaned.set(partitionId, {
        ...assignment,
        primary: null,
        replicas: [],
        inSyncSet: [NODE_ID],
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

  it('serves every document again from the copy on its own disk', async () => {
    const first = await startNode()
    await first.createIndex(
      INDEX_NAME,
      { schema: { title: 'string', price: 'number' } },
      { partitionCount: 2, replicationFactor: 0 },
    )
    const inserted = await first.insertBatch(INDEX_NAME, shopDocuments())
    expect(inserted.failed).toEqual([])
    await first.checkpoint(INDEX_NAME)
    await markEveryPartitionUnassigned()
    await first.shutdown()

    node = await startNode()

    await waitForAllocation(table =>
      [...table.assignments.values()].every(entry => entry.state === 'ACTIVE' && entry.primary === NODE_ID),
    )

    const answered = await node.query(INDEX_NAME, { term: 'portable', limit: DOCUMENT_TOTAL })
    expect(answered.coverage.failedPartitions).toBe(0)
    expect(answered.hits).toHaveLength(DOCUMENT_TOTAL)
  }, 120_000)

  it('numbers a write after the restart above every sequence number its copy already holds', async () => {
    const first = await startNode()
    await first.createIndex(
      INDEX_NAME,
      { schema: { title: 'string', price: 'number' } },
      { partitionCount: 2, replicationFactor: 0 },
    )
    await first.insertBatch(INDEX_NAME, shopDocuments())
    await first.checkpoint(INDEX_NAME)
    await markEveryPartitionUnassigned()
    await first.shutdown()

    node = await startNode()
    await waitForAllocation(table =>
      [...table.assignments.values()].every(entry => entry.state === 'ACTIVE' && entry.primary === NODE_ID),
    )

    await node.insert(INDEX_NAME, { id: 'item-new', title: 'portable grinder replacement', price: 99 })

    const answered = await node.query(INDEX_NAME, { term: 'portable', limit: DOCUMENT_TOTAL + 1 })
    expect(answered.hits).toHaveLength(DOCUMENT_TOTAL + 1)

    await node.shutdown()
    node = await startNode()
    const afterSecondRestart = await node.query(INDEX_NAME, { term: 'portable', limit: DOCUMENT_TOTAL + 1 })
    expect(afterSecondRestart.hits).toHaveLength(DOCUMENT_TOTAL + 1)
  }, 120_000)
})
