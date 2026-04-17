import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import {
  createSnapshotSyncHandlerState,
  handleSnapshotSyncRequest,
  type SnapshotSyncHandlerState,
} from '../../../distribution/cluster-node/snapshot-sync-handler'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
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

function makeThrowingCoordinator(message: string): ClusterCoordinator {
  return {
    getAllocation: vi.fn().mockImplementation(async () => {
      throw new Error(message)
    }),
  } as unknown as ClusterCoordinator
}

interface MockEngineOptions {
  indexes?: Array<{ name: string }>
  snapshotBytes?: Uint8Array
  snapshotRejects?: boolean
  snapshotDelayMs?: number
  snapshotCalls?: { value: number }
}

function makeMockEngine(options: MockEngineOptions = {}): Narsil {
  return {
    listIndexes: vi.fn().mockReturnValue(options.indexes ?? [{ name: 'products' }]),
    snapshot: vi.fn().mockImplementation(async () => {
      if (options.snapshotCalls !== undefined) {
        options.snapshotCalls.value += 1
      }
      if (options.snapshotDelayMs !== undefined) {
        await new Promise(resolve => setTimeout(resolve, options.snapshotDelayMs))
      }
      if (options.snapshotRejects === true) {
        throw new Error('engine snapshot failed')
      }
      return options.snapshotBytes ?? new Uint8Array(0)
    }),
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

function makeRequest(indexName: string, requestId = 'req-1', sourceId = 'replica-node'): TransportMessage {
  return {
    type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
    sourceId,
    requestId,
    payload: encode({ indexName }),
  }
}

function collectResponses(): { respond: (response: TransportMessage) => void; responses: TransportMessage[] } {
  const responses: TransportMessage[] = []
  return {
    respond: (response: TransportMessage) => {
      responses.push(response)
    },
    responses,
  }
}

describe('snapshot sync handler hardening', () => {
  it('T1: active counter returns to zero after two concurrent failed builds', async () => {
    const engine = makeMockEngine({ snapshotRejects: true, snapshotDelayMs: 20 })
    const coordinator = makeCoordinator(
      makeAllocation(
        makeAssignment({
          replicas: ['replica-a', 'replica-b'],
          inSyncSet: ['primary', 'replica-a', 'replica-b'],
        }),
      ),
    )
    const state = createSnapshotSyncHandlerState(2, 5)

    const a = collectResponses()
    const b = collectResponses()

    await Promise.all([
      handleSnapshotSyncRequest(
        makeRequest('products', 'req-a', 'replica-a'),
        a.respond,
        makeDeps(engine, coordinator, state),
      ),
      handleSnapshotSyncRequest(
        makeRequest('products', 'req-b', 'replica-b'),
        b.respond,
        makeDeps(engine, coordinator, state),
      ),
    ])

    expect(state.active).toBe(0)
    expect(state.cache.size).toBe(0)
    expect(state.perSource.size).toBe(0)
  })

  it('T2: coordinator throwing during authorization returns transient ALLOCATION_UNAVAILABLE', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(0) })
    const coordinator = makeThrowingCoordinator('etcd unreachable')
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE)
  })

  it('T3: rejects DECOMMISSIONING replica with SNAPSHOT_SYNC_NOT_ASSIGNED', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(16) })
    const coordinator = makeCoordinator(makeAllocation(makeAssignment({ state: 'DECOMMISSIONING' })))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED)
  })

  it('T3b: rejects UNASSIGNED replica with NOT_ASSIGNED', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(16) })
    const coordinator = makeCoordinator(makeAllocation(makeAssignment({ state: 'UNASSIGNED' })))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED)
  })

  it('T3c: rejects ACTIVE replica that is not in inSyncSet', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(16) })
    const coordinator = makeCoordinator(makeAllocation(makeAssignment({ state: 'ACTIVE', inSyncSet: ['primary'] })))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED)
  })

  it('T3d: authorizes INITIALISING replica that is not yet in inSyncSet', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(4) })
    const coordinator = makeCoordinator(
      makeAllocation(makeAssignment({ state: 'INITIALISING', inSyncSet: ['primary'] })),
    )
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBeGreaterThan(1)
    expect(responses[0].type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
  })

  it('T8: per-source cap rejects a second concurrent request from the same source', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(8), snapshotDelayMs: 30 })
    const coordinator = makeCoordinator(makeAllocation(makeAssignment()))
    const state = createSnapshotSyncHandlerState(4, 1)

    const first = collectResponses()
    const second = collectResponses()

    const p1 = handleSnapshotSyncRequest(
      makeRequest('products', 'req-1'),
      first.respond,
      makeDeps(engine, coordinator, state),
    )
    const p2 = handleSnapshotSyncRequest(
      makeRequest('products', 'req-2'),
      second.respond,
      makeDeps(engine, coordinator, state),
    )

    await Promise.all([p1, p2])

    const p1Success = first.responses.some(r => r.type === ReplicationMessageTypes.SNAPSHOT_START)
    const p2Success = second.responses.some(r => r.type === ReplicationMessageTypes.SNAPSHOT_START)
    expect(p1Success).toBe(true)
    expect(p2Success).toBe(false)
    const rejected = second.responses[0]
    const decoded = decode(rejected.payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED)
    expect(state.active).toBe(0)
    expect(state.perSource.size).toBe(0)
  })

  it('T9: rejects an oversized indexName with REQUEST_INVALID', async () => {
    const engine = makeMockEngine()
    const coordinator = makeCoordinator(makeAllocation(makeAssignment()))
    const { respond, responses } = collectResponses()

    const longName = 'x'.repeat(257)
    const bad: TransportMessage = {
      type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
      sourceId: 'replica-node',
      requestId: 'req-x',
      payload: encode({ indexName: longName }),
    }

    await handleSnapshotSyncRequest(bad, respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
  })

  it('T9b: rejects an indexName with invalid characters', async () => {
    const engine = makeMockEngine()
    const coordinator = makeCoordinator(makeAllocation(makeAssignment()))
    const { respond, responses } = collectResponses()

    const bad: TransportMessage = {
      type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
      sourceId: 'replica-node',
      requestId: 'req-y',
      payload: encode({ indexName: '../etc/passwd' }),
    }

    await handleSnapshotSyncRequest(bad, respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
  })

  it('T10: N+1 requesters for different indices observe at most N concurrent snapshots', async () => {
    const engine = {
      listIndexes: vi.fn().mockReturnValue([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]),
      snapshot: vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        return new Uint8Array(8)
      }),
    } as unknown as Narsil

    const assignment = makeAssignment({
      replicas: ['replica-a', 'replica-b', 'replica-c'],
      inSyncSet: ['primary', 'replica-a', 'replica-b', 'replica-c'],
    })
    const coordinator: ClusterCoordinator = {
      getAllocation: vi.fn().mockImplementation(async (indexName: string) => ({
        indexName,
        version: 1,
        replicationFactor: 1,
        assignments: new Map<number, PartitionAssignment>([[0, assignment]]),
      })),
    } as unknown as ClusterCoordinator

    const state = createSnapshotSyncHandlerState(2, 5)

    const capture: Record<string, ReturnType<typeof collectResponses>> = {
      alpha: collectResponses(),
      beta: collectResponses(),
      gamma: collectResponses(),
    }

    await Promise.all([
      handleSnapshotSyncRequest(
        makeRequest('alpha', 'req-a', 'replica-a'),
        capture.alpha.respond,
        makeDeps(engine, coordinator, state),
      ),
      handleSnapshotSyncRequest(
        makeRequest('beta', 'req-b', 'replica-b'),
        capture.beta.respond,
        makeDeps(engine, coordinator, state),
      ),
      handleSnapshotSyncRequest(
        makeRequest('gamma', 'req-c', 'replica-c'),
        capture.gamma.respond,
        makeDeps(engine, coordinator, state),
      ),
    ])

    const outcomes = ['alpha', 'beta', 'gamma'].map(key => {
      const responses = capture[key].responses
      if (responses.some(r => r.type === ReplicationMessageTypes.SNAPSHOT_START)) {
        return { kind: 'success' as const, key }
      }
      const first = responses[0]
      if (first === undefined) {
        return { kind: 'error' as const, key, code: 'no-response' }
      }
      const decoded = decode(first.payload) as { code?: string }
      return { kind: 'error' as const, key, code: decoded.code ?? 'unknown' }
    })

    const successCount = outcomes.filter(o => o.kind === 'success').length
    const capacityCount = outcomes.filter(
      o => o.kind === 'error' && o.code === ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
    ).length
    expect(successCount + capacityCount).toBe(3)
    expect(successCount).toBeLessThanOrEqual(2)
    expect(successCount).toBeGreaterThanOrEqual(2)
    expect(state.active).toBe(0)
  })

  it('T11: cache is cleared after build settles so a late requester triggers a fresh build', async () => {
    const snapshotCalls = { value: 0 }
    let currentBytes = new Uint8Array(4)
    const engine = {
      listIndexes: vi.fn().mockReturnValue([{ name: 'products' }]),
      snapshot: vi.fn().mockImplementation(async () => {
        snapshotCalls.value += 1
        return currentBytes
      }),
    } as unknown as Narsil

    const coordinator = makeCoordinator(makeAllocation(makeAssignment()))
    const state = createSnapshotSyncHandlerState(4, 5)

    const first = collectResponses()
    await handleSnapshotSyncRequest(
      makeRequest('products', 'req-a'),
      first.respond,
      makeDeps(engine, coordinator, state),
    )
    expect(state.cache.size).toBe(0)
    expect(snapshotCalls.value).toBe(1)

    currentBytes = new Uint8Array(8)

    const second = collectResponses()
    await handleSnapshotSyncRequest(
      makeRequest('products', 'req-b'),
      second.respond,
      makeDeps(engine, coordinator, state),
    )

    expect(snapshotCalls.value).toBe(2)
    expect(state.cache.size).toBe(0)
  })

  it('T12: header partitionId and primaryTerm plumb through from the allocation', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(16) })
    const allocation = makeAllocation(makeAssignment({ primaryTerm: 7 }))
    const coordinator = makeCoordinator(allocation)
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    const start = responses.find(r => r.type === ReplicationMessageTypes.SNAPSHOT_START)
    expect(start).toBeDefined()
    if (start === undefined) {
      return
    }
    const decoded = decode(start.payload) as {
      header: { partitionId: number; primaryTerm: number; lastSeqNo: number }
    }
    expect(decoded.header.primaryTerm).toBe(7)
    expect(decoded.header.partitionId).toBe(0xffff_ffff)
    expect(decoded.header.lastSeqNo).toBe(Number.MAX_SAFE_INTEGER)
  })
})
