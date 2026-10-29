import { afterEach, describe, expect, it } from 'vitest'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import { createTestCluster, INDEX, partitionAssignment, SCHEMA, type TestCluster, waitUntil } from './harness'

const REJOIN_TIMEOUT_MS = 20_000

function withoutInSync(table: AllocationTable, replicaNodeId: string): AllocationTable {
  const assignments = new Map(
    [...table.assignments].map(([partitionId, assignment]) => [
      partitionId,
      { ...assignment, inSyncSet: assignment.inSyncSet.filter(nodeId => nodeId !== replicaNodeId) },
    ]),
  )
  return { ...table, version: table.version + 1, assignments }
}

describe('a replica removed from the in-sync set in the table right after the one that admitted it', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  it('rejoins the in-sync set', async () => {
    cluster = await createTestCluster()
    const started = cluster
    await started.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b']) await started.start(nodeId, { durable: false })

    let removal: { replica: string; version: number } | undefined
    const stopWatching = await started.coordinator.watchAllocation(({ indexName, table }) => {
      const replica = partitionAssignment(table)?.inSyncSet[0]
      if (indexName !== INDEX || removal !== undefined || replica === undefined) return
      const removed = withoutInSync(table, replica)
      removal = { replica, version: removed.version }
      setImmediate(() => void started.coordinator.putAllocation(INDEX, removed))
    })

    await started.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const removed = await waitUntil('the admitted replica to be removed in the next table', async () => {
      const table = await started.coordinator.getAllocation(INDEX)
      return removal !== undefined && table !== null && table.version >= removal.version ? removal : null
    })
    stopWatching()
    expect(partitionAssignment(await started.coordinator.getAllocation(INDEX))?.inSyncSet).not.toContain(
      removed.replica,
    )

    const rejoined = await waitUntil(
      'the replica to rejoin the in-sync set',
      async () => {
        const table = await started.coordinator.getAllocation(INDEX)
        const current = partitionAssignment(table)
        return table !== null && table.version > removed.version && current?.inSyncSet.includes(removed.replica)
          ? current
          : null
      },
      REJOIN_TIMEOUT_MS,
    )
    expect(rejoined.state).toBe('ACTIVE')
  }, 60_000)
})
