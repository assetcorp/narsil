import { encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { handleBootstrapCompleteMessage } from '../../../../distribution/cluster/controller/bootstrap-handler'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator/in-memory'
import type {
  AllocationTable,
  ClusterCoordinator,
  PartitionAssignment,
  PartitionState,
} from '../../../../distribution/coordinator/types'
import { decodePayload } from '../../../../distribution/replication/codec'
import type { BootstrapCompleteResultPayload, TransportMessage } from '../../../../distribution/transport/types'
import { ClusterMessageTypes } from '../../../../distribution/transport/types'

function makeTable(state: PartitionState, overrides: Partial<PartitionAssignment> = {}): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-a',
    replicas: ['node-b'],
    inSyncSet: [],
    state,
    primaryTerm: 1,
    commitPoint: 0,
    ...overrides,
  }
  return {
    indexName: 'products',
    version: 1,
    replicationFactor: 1,
    assignments: new Map([[0, assignment]]),
  }
}

describe('handleBootstrapCompleteMessage', () => {
  let coordinator: ClusterCoordinator

  afterEach(async () => {
    await coordinator.shutdown()
  })

  async function report(table: AllocationTable, nodeId = 'node-b'): Promise<BootstrapCompleteResultPayload> {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation('products', table)

    const message: TransportMessage = {
      type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
      sourceId: nodeId,
      requestId: 'request-1',
      payload: encode({ indexName: 'products', partitionId: 0, nodeId, primaryTerm: 1 }),
    }

    let result: BootstrapCompleteResultPayload | null = null
    await handleBootstrapCompleteMessage(
      message,
      async response => {
        result = decodePayload<BootstrapCompleteResultPayload>(response.payload)
      },
      coordinator,
      'controller',
    )

    if (result === null) throw new Error('expected a response')
    return result
  }

  it('clears the last holders once the partition it recovered reaches ACTIVE', async () => {
    const result = await report(makeTable('INITIALISING', { lastHolders: ['node-a', 'node-c'] }))
    expect(result.accepted).toBe(true)

    const stored = await coordinator.getAllocation('products')
    expect(stored?.assignments.get(0)?.lastHolders).toBeUndefined()
  })

  it('moves an INITIALISING partition to ACTIVE without admitting the reporting replica', async () => {
    const result = await report(makeTable('INITIALISING'))
    expect(result.accepted).toBe(true)

    const stored = await coordinator.getAllocation('products')
    expect(stored?.assignments.get(0)?.state).toBe('ACTIVE')
    expect(stored?.assignments.get(0)?.inSyncSet).toEqual([])
  })

  it('leaves an in-sync set the catch-up feed already filled untouched', async () => {
    const result = await report(makeTable('INITIALISING', { inSyncSet: ['node-b'] }))
    expect(result.accepted).toBe(true)

    const stored = await coordinator.getAllocation('products')
    expect(stored?.assignments.get(0)?.state).toBe('ACTIVE')
    expect(stored?.assignments.get(0)?.inSyncSet).toEqual(['node-b'])
  })

  it('keeps the primary out of the in-sync set when the primary reports its own bootstrap', async () => {
    const result = await report(makeTable('INITIALISING'), 'node-a')
    expect(result.accepted).toBe(true)

    const stored = await coordinator.getAllocation('products')
    expect(stored?.assignments.get(0)?.state).toBe('ACTIVE')
    expect(stored?.assignments.get(0)?.inSyncSet).toEqual([])
  })

  it('refuses a report on a partition that is already ACTIVE', async () => {
    const result = await report(makeTable('ACTIVE'))
    expect(result.accepted).toBe(false)

    const stored = await coordinator.getAllocation('products')
    expect(stored?.assignments.get(0)?.inSyncSet).not.toContain('node-b')
  })

  it('refuses a sender that does not match the reported node', async () => {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation('products', makeTable('INITIALISING'))

    const message: TransportMessage = {
      type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
      sourceId: 'node-c',
      requestId: 'request-1',
      payload: encode({ indexName: 'products', partitionId: 0, nodeId: 'node-b', primaryTerm: 1 }),
    }

    let result: BootstrapCompleteResultPayload | null = null
    await handleBootstrapCompleteMessage(
      message,
      async response => {
        result = decodePayload<BootstrapCompleteResultPayload>(response.payload)
      },
      coordinator,
      'controller',
    )

    expect(result === null ? null : (result as BootstrapCompleteResultPayload).accepted).toBe(false)
  })
})
