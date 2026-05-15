import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import {
  createSnapshotSyncHandlerState,
  handleSnapshotSyncRequest,
  type SnapshotSyncHandlerState,
} from '../../../distribution/cluster-node/snapshot-sync-handler'
import type {
  AllocationTable,
  ClusterCoordinator,
  PartitionAssignment,
  PartitionState,
} from '../../../distribution/coordinator/types'
import { ReplicationMessageTypes, type TransportMessage } from '../../../distribution/transport/types'
import { ErrorCodes } from '../../../errors'
import type { Narsil } from '../../../narsil'

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'primary',
    replicas: ['replica-node'],
    inSyncSet: ['primary', 'replica-node'],
    state: 'ACTIVE',
    primaryTerm: 1,
    ...overrides,
  }
}

function makeAllocation(assignment: PartitionAssignment): AllocationTable {
  const assignments = new Map<number, PartitionAssignment>()
  assignments.set(0, assignment)
  return { indexName: 'products', version: 1, replicationFactor: 1, assignments }
}

function makeCoordinator(allocation: AllocationTable | null): ClusterCoordinator {
  return {
    getAllocation: vi.fn().mockResolvedValue(allocation),
  } as unknown as ClusterCoordinator
}

function makeEngine(bytes = new Uint8Array(4)): Narsil {
  return {
    listIndexes: vi.fn().mockReturnValue([{ name: 'products' }]),
    snapshot: vi.fn().mockResolvedValue(bytes),
  } as unknown as Narsil
}

function makeDeps(
  engine: Narsil,
  coordinator: ClusterCoordinator,
  state: SnapshotSyncHandlerState = createSnapshotSyncHandlerState(),
  nodeId = 'primary',
): {
  nodeId: string
  engine: Narsil
  coordinator: ClusterCoordinator
  state: SnapshotSyncHandlerState
} {
  return { nodeId, engine, coordinator, state }
}

function makeRequest(indexName: string, sourceId = 'replica-node', requestId = 'req-1'): TransportMessage {
  return {
    type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
    sourceId,
    requestId,
    payload: encode({ indexName }),
  }
}

function collect(): { respond: (r: TransportMessage) => void; responses: TransportMessage[] } {
  const responses: TransportMessage[] = []
  return {
    respond: (r: TransportMessage) => {
      responses.push(r)
    },
    responses,
  }
}

describe('authorize primary-requested snapshots', () => {
  it('authorizes a peer that is the primary for the partition', async () => {
    const engine = makeEngine()
    const coordinator = makeCoordinator(makeAllocation(makeAssignment({ primary: 'other-primary', replicas: [] })))
    const { respond, responses } = collect()

    await handleSnapshotSyncRequest(makeRequest('products', 'other-primary'), respond, makeDeps(engine, coordinator))

    expect(responses[0].type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
  })

  it('rejects a peer not listed anywhere with UNAUTHORIZED (not NOT_ASSIGNED)', async () => {
    const engine = makeEngine()
    const coordinator = makeCoordinator(makeAllocation(makeAssignment()))
    const { respond, responses } = collect()

    await handleSnapshotSyncRequest(makeRequest('products', 'stranger'), respond, makeDeps(engine, coordinator))

    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED)
  })

  it('walks every partition assignment and accepts a match in any entry', async () => {
    const table: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments: new Map<number, PartitionAssignment>([
        [0, makeAssignment({ replicas: [] })],
        [1, makeAssignment({ replicas: ['replica-node'] })],
      ]),
    }
    const engine = makeEngine()
    const coordinator = makeCoordinator(table)
    const { respond, responses } = collect()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses[0].type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
  })
})

describe('bootstrappable partition state coverage', () => {
  const cases: Array<{ state: PartitionState; expected: 'SNAPSHOT_SYNC_NOT_ASSIGNED' | 'SNAPSHOT_START' }> = [
    { state: 'UNASSIGNED', expected: 'SNAPSHOT_SYNC_NOT_ASSIGNED' },
    { state: 'INITIALISING', expected: 'SNAPSHOT_START' },
    { state: 'MIGRATING', expected: 'SNAPSHOT_START' },
    { state: 'DECOMMISSIONING', expected: 'SNAPSHOT_SYNC_NOT_ASSIGNED' },
  ]

  for (const { state, expected } of cases) {
    it(`state ${state} => ${expected}`, async () => {
      const engine = makeEngine()
      const assignment = makeAssignment({ state, inSyncSet: ['primary'] })
      const coordinator = makeCoordinator(makeAllocation(assignment))
      const { respond, responses } = collect()

      await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

      if (expected === 'SNAPSHOT_START') {
        expect(responses[0].type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
      } else {
        const decoded = decode(responses[0].payload) as { code: string }
        expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED)
      }
    })
  }
})
