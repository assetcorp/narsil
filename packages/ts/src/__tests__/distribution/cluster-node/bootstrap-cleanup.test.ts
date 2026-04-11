import { describe, expect, it, vi } from 'vitest'
import { cleanupRemovedPartition } from '../../../distribution/cluster-node/bootstrap-cleanup'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import type { Narsil } from '../../../narsil'

function makeEngine(hasIndex: boolean): { engine: Narsil; drops: string[] } {
  const drops: string[] = []
  let present = hasIndex
  const engine = {
    listIndexes: () => (present ? [{ name: 'products' }] : []),
    dropIndex: async (name: string) => {
      present = false
      drops.push(name)
    },
  } as unknown as Narsil
  return { engine, drops }
}

function makeAllocation(assignments: Map<number, PartitionAssignment>): AllocationTable {
  return { indexName: 'products', version: 1, replicationFactor: 1, assignments }
}

function makeCoordinator(allocation: AllocationTable | null): ClusterCoordinator {
  return {
    getAllocation: vi.fn().mockResolvedValue(allocation),
  } as unknown as ClusterCoordinator
}

describe('cleanupRemovedPartition (L-D)', () => {
  it('drops the local index when the removed partition was the last one assigned to this node', async () => {
    const { engine, drops } = makeEngine(true)
    const assignments = new Map<number, PartitionAssignment>()
    assignments.set(0, {
      primary: 'other-node',
      replicas: ['other-node'],
      inSyncSet: ['other-node'],
      state: 'ACTIVE',
      primaryTerm: 1,
    })
    const coordinator = makeCoordinator(makeAllocation(assignments))

    await cleanupRemovedPartition('products', 0, { engine, coordinator, nodeId: 'this-node' })

    expect(drops).toEqual(['products'])
  })

  it('does not drop the local index when another partition of the same index is still assigned to this node', async () => {
    const { engine, drops } = makeEngine(true)
    const assignments = new Map<number, PartitionAssignment>()
    assignments.set(0, {
      primary: 'other-node',
      replicas: ['other-node'],
      inSyncSet: ['other-node'],
      state: 'ACTIVE',
      primaryTerm: 1,
    })
    assignments.set(1, {
      primary: 'this-node',
      replicas: ['this-node'],
      inSyncSet: ['this-node'],
      state: 'ACTIVE',
      primaryTerm: 1,
    })
    const coordinator = makeCoordinator(makeAllocation(assignments))

    await cleanupRemovedPartition('products', 0, { engine, coordinator, nodeId: 'this-node' })

    expect(drops).toEqual([])
  })

  it('is a no-op when the engine does not host the index', async () => {
    const { engine, drops } = makeEngine(false)
    const coordinator = makeCoordinator(null)

    await cleanupRemovedPartition('products', 0, { engine, coordinator, nodeId: 'this-node' })

    expect(drops).toEqual([])
  })

  it('does not drop when the allocation lookup throws; pessimistic retention keeps live partitions safe', async () => {
    const { engine, drops } = makeEngine(true)
    const coordinator = {
      getAllocation: vi.fn().mockRejectedValue(new Error('coordinator down')),
    } as unknown as ClusterCoordinator

    await cleanupRemovedPartition('products', 0, { engine, coordinator, nodeId: 'this-node' })

    expect(drops).toEqual([])
  })

  it('drops when the allocation is null; no partitions remain assigned cluster-wide', async () => {
    const { engine, drops } = makeEngine(true)
    const coordinator = makeCoordinator(null)

    await cleanupRemovedPartition('products', 0, { engine, coordinator, nodeId: 'this-node' })

    expect(drops).toEqual(['products'])
  })

  it('reports errors via onError when dropIndex throws', async () => {
    const engine = {
      listIndexes: () => [{ name: 'products' }],
      dropIndex: async () => {
        throw new Error('drop failed')
      },
    } as unknown as Narsil
    const coordinator = makeCoordinator(null)
    const onError = vi.fn()

    await cleanupRemovedPartition('products', 0, { engine, coordinator, nodeId: 'this-node', onError })

    expect(onError).toHaveBeenCalled()
  })
})
