import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recoverUnassignedPartitions } from '../../../../distribution/cluster/controller/event-loop/unassigned-recovery'
import { putIndexMetadata } from '../../../../distribution/cluster/index-metadata'
import { validatePartitionStoresPayload } from '../../../../distribution/cluster/partition-stores'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator/in-memory'
import type {
  AllocationTable,
  ClusterCoordinator,
  PartitionAssignment,
} from '../../../../distribution/coordinator/types'
import { handleInsyncRemoval } from '../../../../distribution/replication/insync'
import type { InMemoryNetwork, NodeTransport } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import { ClusterMessageTypes, type TransportMessage } from '../../../../distribution/transport/types'

const INDEX_NAME = 'products'
const INDEX_UUID = '2f1c4d18-6a5f-4d0e-9c3b-0f8a7b6c5d4e'

function unassigned(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: null,
    replicas: [],
    inSyncSet: ['node-a', 'node-b'],
    state: 'UNASSIGNED',
    primaryTerm: 4,
    commitPoint: 17,
    ...overrides,
  }
}

function tableOf(assignments: Array<[number, PartitionAssignment]>): AllocationTable {
  return {
    indexName: INDEX_NAME,
    version: 1,
    replicationFactor: 1,
    assignments: new Map(assignments),
  }
}

describe('recovering a partition no node serves', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let controllerTransport: NodeTransport
  const holderTransports: NodeTransport[] = []

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller', network)
    await putIndexMetadata(coordinator, {
      indexUuid: INDEX_UUID,
      indexName: INDEX_NAME,
      partitionCount: 2,
      replicationFactor: 1,
      constraints: { zoneAwareness: false, zoneAttribute: 'zone', maxShardsPerNode: null },
    })
  })

  afterEach(async () => {
    for (const transport of holderTransports.splice(0)) {
      await transport.shutdown()
    }
    await controllerTransport.shutdown()
    await coordinator.shutdown()
  })

  async function answerAs(nodeId: string, answer: { indexUuid: string | null; partitionIds: number[] }): Promise<void> {
    const transport = createInMemoryTransport(nodeId, network)
    holderTransports.push(transport)
    await transport.listen(async (message: TransportMessage, respond) => {
      if (message.type !== ClusterMessageTypes.PARTITION_STORES) {
        return
      }
      const payload = validatePartitionStoresPayload(decode(message.payload))
      expect(payload?.indexName).toBe(INDEX_NAME)
      await respond({
        type: ClusterMessageTypes.PARTITION_STORES,
        sourceId: nodeId,
        requestId: message.requestId,
        payload: encode({ indexName: INDEX_NAME, ...answer }),
      })
    })
  }

  function recover(liveNodeIds: string[]): Promise<boolean> {
    const nodes = liveNodeIds.map(nodeId => ({
      nodeId,
      address: `${nodeId}:9301`,
      roles: ['data' as const],
      capacity: { memoryBytes: 4_000_000_000, cpuCores: 4, diskBytes: null },
      startedAt: '2026-08-24T00:00:00Z',
      version: '0.2.2',
    }))
    return recoverUnassignedPartitions(coordinator, controllerTransport, INDEX_NAME, 'controller', nodes, () => true)
  }

  it('promotes a returning holder whose copy names the partition', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned()]]))
    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [0] })

    expect(await recover(['node-a'])).toBe(true)

    const assignment = (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)
    expect(assignment).toMatchObject({
      primary: 'node-a',
      replicas: [],
      inSyncSet: [],
      state: 'INITIALISING',
      primaryTerm: 5,
      commitPoint: 17,
    })
  })

  it('refuses a holder whose copy carries a different index identity', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned()]]))
    await answerAs('node-a', { indexUuid: 'a-different-identity', partitionIds: [0] })

    expect(await recover(['node-a'])).toBe(false)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.state).toBe('UNASSIGNED')
  })

  it('refuses a holder whose copy holds nothing for the partition', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned()]]))
    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [1] })

    expect(await recover(['node-a'])).toBe(false)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.state).toBe('UNASSIGNED')
  })

  it('asks no node while every recorded holder is still offline', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned()]]))

    expect(await recover(['node-c'])).toBe(false)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.state).toBe('UNASSIGNED')
  })

  it('leaves a partition an active node already serves alone', async () => {
    const active: PartitionAssignment = {
      primary: 'node-a',
      replicas: [],
      inSyncSet: [],
      state: 'ACTIVE',
      primaryTerm: 2,
      commitPoint: 3,
    }
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, active]]))
    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [0] })

    expect(await recover(['node-a'])).toBe(false)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)).toMatchObject({
      state: 'ACTIVE',
      primaryTerm: 2,
    })
  })

  it('recovers each unserved partition from the holder that answers for it', async () => {
    await coordinator.putAllocation(
      INDEX_NAME,
      tableOf([
        [0, unassigned({ inSyncSet: ['node-a'] })],
        [1, unassigned({ inSyncSet: ['node-b'] })],
      ]),
    )
    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [0] })
    await answerAs('node-b', { indexUuid: INDEX_UUID, partitionIds: [1] })

    expect(await recover(['node-a', 'node-b'])).toBe(true)

    const table = await coordinator.getAllocation(INDEX_NAME)
    expect(table?.assignments.get(0)?.primary).toBe('node-a')
    expect(table?.assignments.get(1)?.primary).toBe('node-b')
  })

  it('leaves the partition unserved when the holder never answers', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))

    expect(await recover(['node-a'])).toBe(false)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.state).toBe('UNASSIGNED')
  })
})

describe('protecting the record of a partition no node serves', () => {
  let coordinator: ClusterCoordinator

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  it('refuses to strip a last holder out of an unserved partition', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a', 'node-b'] })]]))

    const answer = await handleInsyncRemoval(
      { indexName: INDEX_NAME, partitionId: 0, replicaNodeId: 'node-b', primaryTerm: 4 },
      coordinator,
    )

    expect(answer.accepted).toBe(false)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.inSyncSet).toEqual(['node-a', 'node-b'])
  })

  it('still removes a replica that has fallen behind on a partition it serves', async () => {
    const active: PartitionAssignment = {
      primary: 'node-a',
      replicas: ['node-b'],
      inSyncSet: ['node-b'],
      state: 'ACTIVE',
      primaryTerm: 4,
      commitPoint: 17,
    }
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, active]]))

    const answer = await handleInsyncRemoval(
      { indexName: INDEX_NAME, partitionId: 0, replicaNodeId: 'node-b', primaryTerm: 4 },
      coordinator,
    )

    expect(answer.accepted).toBe(true)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.inSyncSet).toEqual([])
  })
})

describe('recording why a partition stays unserved', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let controllerTransport: NodeTransport
  const holderTransports: NodeTransport[] = []

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller', network)
    await putIndexMetadata(coordinator, {
      indexUuid: INDEX_UUID,
      indexName: INDEX_NAME,
      partitionCount: 2,
      replicationFactor: 1,
      constraints: { zoneAwareness: false, zoneAttribute: 'zone', maxShardsPerNode: null },
    })
  })

  afterEach(async () => {
    for (const transport of holderTransports.splice(0)) {
      await transport.shutdown()
    }
    await controllerTransport.shutdown()
    await coordinator.shutdown()
  })

  async function answerAs(nodeId: string, answer: { indexUuid: string | null; partitionIds: number[] }): Promise<void> {
    const transport = createInMemoryTransport(nodeId, network)
    holderTransports.push(transport)
    await transport.listen(async (message: TransportMessage, respond) => {
      if (message.type !== ClusterMessageTypes.PARTITION_STORES) {
        return
      }
      await respond({
        type: ClusterMessageTypes.PARTITION_STORES,
        sourceId: nodeId,
        requestId: message.requestId,
        payload: encode({ indexName: INDEX_NAME, ...answer }),
      })
    })
  }

  function recover(liveNodeIds: string[]): Promise<boolean> {
    const nodes = liveNodeIds.map(nodeId => ({
      nodeId,
      address: `${nodeId}:9301`,
      roles: ['data' as const],
      capacity: { memoryBytes: 4_000_000_000, cpuCores: 4, diskBytes: null },
      startedAt: '2026-08-24T00:00:00Z',
      version: '0.2.2',
    }))
    return recoverUnassignedPartitions(coordinator, controllerTransport, INDEX_NAME, 'controller', nodes, () => true)
  }

  async function reasonAfterRecovery(liveNodeIds: string[]): Promise<string | undefined> {
    await recover(liveNodeIds)
    return (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.unassignedReason
  }

  it('reports that it is still waiting while every last holder is offline', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))

    expect(await reasonAfterRecovery(['node-c'])).toBe('HOLDER_OFFLINE')
  })

  it('reports a live holder that left the request unanswered', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))

    expect(await reasonAfterRecovery(['node-a'])).toBe('HOLDER_UNREACHABLE')
  })

  it('reports a holder answering for a different index of the same name', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))
    await answerAs('node-a', { indexUuid: 'a-different-identity', partitionIds: [0] })

    expect(await reasonAfterRecovery(['node-a'])).toBe('HOLDER_IDENTITY_MISMATCH')
  })

  it('reports a holder keeping no copy of the index under the identity it answered with', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))
    await answerAs('node-a', { indexUuid: null, partitionIds: [] })

    expect(await reasonAfterRecovery(['node-a'])).toBe('HOLDER_IDENTITY_MISMATCH')
  })

  it('gives up on a holder that takes the request and never answers', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))
    const silent = createInMemoryTransport('node-a', network)
    holderTransports.push(silent)
    await silent.listen(async () => new Promise<void>(() => undefined))

    expect(await reasonAfterRecovery(['node-a'])).toBe('HOLDER_UNREACHABLE')
  }, 30_000)

  it('reports that no holder answered with the data', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))
    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [1] })

    expect(await reasonAfterRecovery(['node-a'])).toBe('HOLDER_WITHOUT_DATA')
  })

  it('reports waiting ahead of refusal while one of several holders is still offline', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a', 'node-b'] })]]))
    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [1] })

    expect(await reasonAfterRecovery(['node-a'])).toBe('HOLDER_OFFLINE')
  })

  it('clears the reason once it promotes a holder', async () => {
    await coordinator.putAllocation(
      INDEX_NAME,
      tableOf([[0, unassigned({ inSyncSet: ['node-a'], unassignedReason: 'HOLDER_OFFLINE' })]]),
    )
    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [0] })

    expect(await recover(['node-a'])).toBe(true)
    const assignment = (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)
    expect(assignment?.primary).toBe('node-a')
    expect(assignment?.unassignedReason).toBeUndefined()
  })

  it('keeps asking after a run that recorded a reason', async () => {
    await coordinator.putAllocation(INDEX_NAME, tableOf([[0, unassigned({ inSyncSet: ['node-a'] })]]))
    expect(await reasonAfterRecovery(['node-c'])).toBe('HOLDER_OFFLINE')

    await answerAs('node-a', { indexUuid: INDEX_UUID, partitionIds: [0] })
    expect(await recover(['node-a'])).toBe(true)
    expect((await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)?.primary).toBe('node-a')
  })
})
