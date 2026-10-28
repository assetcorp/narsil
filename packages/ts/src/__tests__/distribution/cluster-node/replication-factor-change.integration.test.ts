import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'

const INDEX_NAME = 'herbarium'
const PARTITION_COUNT = 4
const SETTLE_WAIT_MS = 30_000
const SPECIMENS = Array.from({ length: 60 }, (_, index) => ({
  id: `specimen-${index}`,
  title: `pressed fern ${index}`,
}))
const ORACLE_IDS = SPECIMENS.map(specimen => specimen.id).sort()

interface RefusingCoordinator {
  coordinator: ClusterCoordinator
  refuseTableWrites: (refuse: boolean) => void
}

function refusingCoordinator(inner: ClusterCoordinator): RefusingCoordinator {
  let refusing = false
  const coordinator: ClusterCoordinator = {
    ...inner,
    async putAllocation(
      indexName: string,
      table: AllocationTable,
      expectedVersion?: number | null,
      writerNodeId?: string,
    ): Promise<boolean> {
      if (refusing && writerNodeId !== undefined) return false
      if (expectedVersion === undefined || writerNodeId === undefined) return inner.putAllocation(indexName, table)
      return inner.putAllocation(indexName, table, expectedVersion, writerNodeId)
    },
  }
  return {
    coordinator,
    refuseTableWrites: refuse => {
      refusing = refuse
    },
  }
}

function settledAt(table: AllocationTable | null, replicationFactor: number, replicaCount: number): boolean {
  if (table === null || table.assignments.size !== PARTITION_COUNT || table.replicationFactor !== replicationFactor) {
    return false
  }
  return [...table.assignments.values()].every(
    entry =>
      entry.state === 'ACTIVE' &&
      entry.primary !== null &&
      entry.replicas.length === replicaCount &&
      entry.replicas.every(replica => entry.inSyncSet.includes(replica)),
  )
}

describe('changing the replication factor of a cluster index', () => {
  let inner: ClusterCoordinator
  let refusing: RefusingCoordinator
  let network: InMemoryNetwork
  const running: ClusterNode[] = []

  async function start(nodeId: string, roles: Array<'data' | 'coordinator' | 'controller'>): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator: refusing.coordinator,
      transport: createInMemoryTransport(nodeId, network),
      address: nodeId,
      nodeId,
      roles,
      controller: { nodeLeftDelayMs: 0 },
    })
    running.push(node)
    await node.start()
    return node
  }

  async function waitForFactor(
    replicationFactor: number,
    replicaCount: number = replicationFactor,
  ): Promise<AllocationTable> {
    const deadline = Date.now() + SETTLE_WAIT_MS
    let last: AllocationTable | null = null
    while (Date.now() < deadline) {
      last = await inner.getAllocation(INDEX_NAME)
      if (last !== null && settledAt(last, replicationFactor, replicaCount)) return last
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(
      `the index never settled at factor ${replicationFactor}: ${JSON.stringify([...(last?.assignments ?? [])])}`,
    )
  }

  async function searchedIds(node: ClusterNode): Promise<string[]> {
    const answer = await node.query(INDEX_NAME, { term: 'fern', limit: 100 })
    expect(answer.coverage.queriedPartitions).toBe(PARTITION_COUNT)
    return answer.hits.map(hit => hit.id).sort()
  }

  async function startCluster(replicationFactor: number): Promise<ClusterNode> {
    const router = await start('curator', ['coordinator', 'controller'])
    await start('cabinet-a', ['data'])
    await start('cabinet-b', ['data'])
    await start('cabinet-c', ['data'])
    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor },
    )
    await waitForFactor(replicationFactor)
    expect((await router.insertBatch(INDEX_NAME, SPECIMENS)).failed).toEqual([])
    return router
  }

  beforeEach(() => {
    inner = createInMemoryCoordinator()
    refusing = refusingCoordinator(inner)
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    await inner.shutdown()
  })

  it('adds replicas that hold every document, so the index survives losing the node that held the only copy', async () => {
    const router = await startCluster(0)

    await router.cluster.setReplicationFactor(INDEX_NAME, 2)
    await waitForFactor(2)

    const lost = running.find(node => node.nodeId === 'cabinet-a')
    if (lost === undefined) throw new Error('cabinet-a never started')
    await lost.shutdown()
    await waitForFactor(2, 1)

    expect(await searchedIds(router)).toEqual(ORACLE_IDS)
  }, 60_000)

  it('drops surplus replicas and keeps every primary where it was', async () => {
    const router = await startCluster(2)
    const before = await waitForFactor(2)

    await router.cluster.setReplicationFactor(INDEX_NAME, 0)
    const after = await waitForFactor(0)

    for (const [partitionId, entry] of before.assignments) {
      expect(after.assignments.get(partitionId)?.primary).toBe(entry.primary)
    }
    expect(await searchedIds(router)).toEqual(ORACLE_IDS)
  }, 60_000)

  it('applies the stored factor once the table write that followed it failed', async () => {
    const router = await startCluster(0)

    refusing.refuseTableWrites(true)
    await expect(router.cluster.setReplicationFactor(INDEX_NAME, 1)).rejects.toMatchObject({
      code: 'ALLOCATION_FAILED',
    })
    expect((await inner.getAllocation(INDEX_NAME))?.replicationFactor).toBe(0)
    refusing.refuseTableWrites(false)

    await waitForFactor(1)
    expect(await searchedIds(router)).toEqual(ORACLE_IDS)
  }, 60_000)

  it.each([
    [1.5],
    [-1],
    [256],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
  ])('refuses the factor %s and leaves the table as it was', async replicationFactor => {
    const router = await startCluster(1)
    const before = await inner.getAllocation(INDEX_NAME)

    await expect(router.cluster.setReplicationFactor(INDEX_NAME, replicationFactor)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
    expect((await inner.getAllocation(INDEX_NAME))?.version).toBe(before?.version)
  }, 60_000)

  it('refuses an index that the cluster does not hold', async () => {
    const router = await startCluster(1)

    await expect(router.cluster.setReplicationFactor('absent-herbarium', 1)).rejects.toMatchObject({
      code: 'INDEX_NOT_FOUND',
    })
  }, 60_000)
})
