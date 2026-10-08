import { describe, expect, it } from 'vitest'
import { putIndexMetadata } from '../../../distribution/cluster/index-metadata'
import { type ClusterLocalEngine, createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import type { PrimaryPartitionDeps } from '../../../distribution/cluster-node/primary-partition'
import { preparePrimaryPartition } from '../../../distribution/cluster-node/primary-partition'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import type { ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { ErrorCodes } from '../../../errors'

const INDEX_NAME = 'shop'
const NODE_ID = 'node-a'
const COMMIT_POINT = 17

interface SeededLog {
  startSeqNo: number
  lastPrimaryTerm: number
}

function assignmentOf(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: NODE_ID,
    replicas: [],
    inSyncSet: [],
    state: 'INITIALISING',
    primaryTerm: 5,
    commitPoint: COMMIT_POINT,
    ...overrides,
  }
}

async function coordinatorHolding(assignment: PartitionAssignment): Promise<ClusterCoordinator> {
  const coordinator = createInMemoryCoordinator()
  await coordinator.putSchema(INDEX_NAME, { title: 'string' })
  await coordinator.putAllocation(INDEX_NAME, {
    indexName: INDEX_NAME,
    version: 1,
    replicationFactor: 0,
    assignments: new Map([[0, assignment]]),
  })
  return coordinator
}

function depsFor(
  coordinator: ClusterCoordinator,
  persistedSeqNo: number,
  seeded: SeededLog[],
  logPosition = 0,
): PrimaryPartitionDeps {
  const engine = {
    listIndexes: () => [{ name: INDEX_NAME }],
    getStats: () => ({ schema: { title: 'string' } }),
    highestPersistedSeqNoOf: () => persistedSeqNo,
  } as unknown as ClusterLocalEngine
  return {
    engine,
    coordinator,
    nodeId: NODE_ID,
    seedReplicationLog: (_indexName, _partitionId, startSeqNo, lastPrimaryTerm) =>
      seeded.push({ startSeqNo, lastPrimaryTerm }),
    replicationLogPosition: () => logPosition,
    onError: error => {
      throw error
    },
  }
}

describe('a node the controller promoted back to primary', () => {
  it('numbers its next entry above the commit point when it held the partition as a replica', async () => {
    const coordinator = await coordinatorHolding(assignmentOf())
    const seeded: SeededLog[] = []

    expect(await preparePrimaryPartition(INDEX_NAME, 0, depsFor(coordinator, 0, seeded))).toBe(true)

    expect(seeded).toEqual([{ startSeqNo: COMMIT_POINT + 1, lastPrimaryTerm: 5 }])
    await coordinator.shutdown()
  })

  it('numbers its next entry above its own write-ahead log when that reaches further', async () => {
    const coordinator = await coordinatorHolding(assignmentOf())
    const seeded: SeededLog[] = []

    expect(await preparePrimaryPartition(INDEX_NAME, 0, depsFor(coordinator, 40, seeded))).toBe(true)

    expect(seeded).toEqual([{ startSeqNo: 41, lastPrimaryTerm: 5 }])
    await coordinator.shutdown()
  })

  it('creates its missing copy with the settings that the index metadata stores', async () => {
    const coordinator = createInMemoryCoordinator()
    await coordinator.putSchema(INDEX_NAME, { title: 'string', sku: 'verbatim' })
    await putIndexMetadata(coordinator, {
      indexUuid: 'shop-uuid',
      indexName: INDEX_NAME,
      partitionCount: 1,
      replicationFactor: 0,
      constraints: { zoneAwareness: false, zoneAttribute: 'zone', maxShardsPerNode: null },
      settings: { language: 'english', patternValueLimit: 4, required: ['sku'] },
    })
    await coordinator.putAllocation(INDEX_NAME, {
      indexName: INDEX_NAME,
      version: 1,
      replicationFactor: 0,
      assignments: new Map([[0, assignmentOf()]]),
    })
    const engine = await createClusterLocalEngine({ workers: { enabled: false } })

    try {
      const deps: PrimaryPartitionDeps = {
        ...depsFor(coordinator, 0, []),
        engine,
      }
      expect(await preparePrimaryPartition(INDEX_NAME, 0, deps)).toBe(true)

      await expect(engine.insert(INDEX_NAME, { title: 'Lamp', sku: 'LAMP' }, 'lamp')).resolves.toBe('lamp')
      await expect(engine.insert(INDEX_NAME, { title: 'Desk', sku: 'DESK-01' }, 'desk')).rejects.toMatchObject({
        code: ErrorCodes.DOC_VALIDATION_FAILED,
      })
      await expect(engine.insert(INDEX_NAME, { title: 'Chair' }, 'chair')).rejects.toMatchObject({
        code: ErrorCodes.DOC_MISSING_REQUIRED_FIELD,
      })
    } finally {
      await engine.shutdown()
      await coordinator.shutdown()
    }
  })

  it('leaves a log that already holds entries alone', async () => {
    const coordinator = await coordinatorHolding(assignmentOf())
    const seeded: SeededLog[] = []

    expect(await preparePrimaryPartition(INDEX_NAME, 0, depsFor(coordinator, 40, seeded, 12))).toBe(true)

    expect(seeded).toEqual([])
    await coordinator.shutdown()
  })
})
