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

function makeAllocation(indexName: string, assignment: PartitionAssignment): AllocationTable {
  const assignments = new Map<number, PartitionAssignment>()
  assignments.set(0, assignment)
  return { indexName, version: 1, replicationFactor: 1, assignments }
}

function makeCoordinator(allocation: AllocationTable | null): ClusterCoordinator {
  return {
    getAllocation: vi
      .fn()
      .mockImplementation(async (name: string) => (allocation === null ? null : { ...allocation, indexName: name })),
  } as unknown as ClusterCoordinator
}

function makeRequest(
  indexName: string,
  requestId: string,
  sourceId = 'replica-node',
  payloadOverride?: Uint8Array,
): TransportMessage {
  return {
    type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
    sourceId,
    requestId,
    payload: payloadOverride ?? encode({ indexName }),
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

function makeEngine(indexes: string[], snapshotDelayMs = 0): Narsil {
  return {
    listIndexes: vi.fn().mockReturnValue(indexes.map(name => ({ name }))),
    snapshot: vi.fn().mockImplementation(async () => {
      if (snapshotDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, snapshotDelayMs))
      }
      return new Uint8Array(16)
    }),
  } as unknown as Narsil
}

function makeDeps(
  engine: Narsil,
  coordinator: ClusterCoordinator,
  state: SnapshotSyncHandlerState,
): {
  nodeId: string
  engine: Narsil
  coordinator: ClusterCoordinator
  state: SnapshotSyncHandlerState
} {
  return { nodeId: 'primary', engine, coordinator, state }
}

describe('snapshot-sync-handler pass-4 findings', () => {
  it('L-H: oversized SNAPSHOT_SYNC_REQUEST payloads are rejected before msgpack decode', async () => {
    const engine = makeEngine(['products'])
    const coordinator = makeCoordinator(makeAllocation('products', makeAssignment()))
    const state = createSnapshotSyncHandlerState()
    const { respond, responses } = collectResponses()

    // Force an oversized but structurally valid payload by padding an extra field.
    const oversized = new Uint8Array(5_000)
    oversized.fill(0)
    const msg = makeRequest('products', 'req-oversized', 'replica-node', oversized)

    await handleSnapshotSyncRequest(msg, respond, makeDeps(engine, coordinator, state))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string; message: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
    expect(decoded.message).toContain('exceeds')
    const snapshot = engine.snapshot as unknown as ReturnType<typeof vi.fn>
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('I-D: after the handler resolves, no further responses are emitted and no async straggler fires', async () => {
    const engine = makeEngine(['products'])
    const coordinator = makeCoordinator(makeAllocation('products', makeAssignment()))
    const state = createSnapshotSyncHandlerState()
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products', 'req-1'), respond, makeDeps(engine, coordinator, state))

    const last = responses.at(-1)
    expect(last?.type).toBe(ReplicationMessageTypes.SNAPSHOT_END)
    const endIndex = responses.findIndex(r => r.type === ReplicationMessageTypes.SNAPSHOT_END)
    expect(endIndex).toBe(responses.length - 1)

    // Active probe: yield to both the microtask and macrotask queues so any
    // straggling async continuation inside the handler has a chance to fire
    // against the captured respond callback. The count must not grow.
    const beforeLength = responses.length
    await Promise.resolve()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(responses.length).toBe(beforeLength)
  })

  it('M-D: same sourceId can request two different indices concurrently without contention', async () => {
    const engine = makeEngine(['alpha', 'beta'], 30)
    const coordinator: ClusterCoordinator = {
      getAllocation: vi.fn().mockImplementation(async (indexName: string) => {
        const assignments = new Map<number, PartitionAssignment>()
        assignments.set(0, makeAssignment())
        return { indexName, version: 1, replicationFactor: 1, assignments }
      }),
    } as unknown as ClusterCoordinator
    const state = createSnapshotSyncHandlerState(4, 1, 4)

    const alphaResp = collectResponses()
    const betaResp = collectResponses()

    await Promise.all([
      handleSnapshotSyncRequest(
        makeRequest('alpha', 'req-alpha', 'replica-node'),
        alphaResp.respond,
        makeDeps(engine, coordinator, state),
      ),
      handleSnapshotSyncRequest(
        makeRequest('beta', 'req-beta', 'replica-node'),
        betaResp.respond,
        makeDeps(engine, coordinator, state),
      ),
    ])

    const alphaStarted = alphaResp.responses.some(r => r.type === ReplicationMessageTypes.SNAPSHOT_START)
    const betaStarted = betaResp.responses.some(r => r.type === ReplicationMessageTypes.SNAPSHOT_START)
    expect(alphaStarted).toBe(true)
    expect(betaStarted).toBe(true)
    expect(state.perSource.size).toBe(0)
  })

  it('M-B: per-index stream fan-out is bounded by maxStreamsPerIndex', async () => {
    const engine = makeEngine(['products'], 40)
    const coordinator = makeCoordinator(
      makeAllocation(
        'products',
        makeAssignment({
          replicas: ['replica-a', 'replica-b', 'replica-c'],
          inSyncSet: ['primary', 'replica-a', 'replica-b', 'replica-c'],
        }),
      ),
    )
    const state = createSnapshotSyncHandlerState(4, 4, 2)

    const captures = ['replica-a', 'replica-b', 'replica-c'].map(() => collectResponses())

    await Promise.all(
      captures.map((cap, idx) =>
        handleSnapshotSyncRequest(
          makeRequest('products', `req-${idx}`, ['replica-a', 'replica-b', 'replica-c'][idx]),
          cap.respond,
          makeDeps(engine, coordinator, state),
        ),
      ),
    )

    const outcomes = captures.map(cap => {
      if (cap.responses.some(r => r.type === ReplicationMessageTypes.SNAPSHOT_START)) {
        return 'success' as const
      }
      const first = cap.responses[0]
      if (first === undefined) {
        return 'no-response' as const
      }
      const decoded = decode(first.payload) as { code?: string }
      return decoded.code ?? 'unknown'
    })

    const successes = outcomes.filter(o => o === 'success').length
    const rejects = outcomes.filter(o => o === ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED).length
    expect(successes).toBeLessThanOrEqual(2)
    expect(successes + rejects).toBe(3)
    expect(state.streamActive.size).toBe(0)
  })

  it('L-new-2: sourceId containing NUL is rejected before slot acquisition or engine work', async () => {
    const engine = makeEngine(['products'])
    const listIndexesSpy = engine.listIndexes as unknown as ReturnType<typeof vi.fn>
    const snapshotSpy = engine.snapshot as unknown as ReturnType<typeof vi.fn>
    const coordinator = makeCoordinator(makeAllocation('products', makeAssignment()))
    const state = createSnapshotSyncHandlerState()
    const { respond, responses } = collectResponses()

    const msg = makeRequest('products', 'req-nul', 'victim\u0000products')
    await handleSnapshotSyncRequest(msg, respond, makeDeps(engine, coordinator, state))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string; message: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
    expect(decoded.message.toLowerCase()).toContain('control')

    expect(listIndexesSpy).not.toHaveBeenCalled()
    expect(snapshotSpy).not.toHaveBeenCalled()
    expect(state.perSource.size).toBe(0)
    expect(state.streamActive.size).toBe(0)
  })

  it('L-new-2: sourceId with other ASCII control characters is rejected the same way', async () => {
    const engine = makeEngine(['products'])
    const coordinator = makeCoordinator(makeAllocation('products', makeAssignment()))
    const state = createSnapshotSyncHandlerState()
    const { respond, responses } = collectResponses()

    const msg = makeRequest('products', 'req-tab', 'bad\tsource')
    await handleSnapshotSyncRequest(msg, respond, makeDeps(engine, coordinator, state))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
  })

  it('M-C: single-chunk snapshot yields at least once between START and END', async () => {
    const originalSetImmediate = globalThis.setImmediate
    const yields: unknown[] = []
    const recordingImmediate = ((cb: () => void): unknown => {
      yields.push(cb)
      return originalSetImmediate.call(globalThis, cb)
    }) as typeof setImmediate
    ;(recordingImmediate as unknown as { __promisify__?: unknown }).__promisify__ = (
      originalSetImmediate as unknown as { __promisify__?: unknown }
    ).__promisify__
    globalThis.setImmediate = recordingImmediate

    try {
      const engine = makeEngine(['products'])
      const coordinator = makeCoordinator(makeAllocation('products', makeAssignment()))
      const state = createSnapshotSyncHandlerState()
      const { respond } = collectResponses()

      await handleSnapshotSyncRequest(
        makeRequest('products', 'req-yield'),
        respond,
        makeDeps(engine, coordinator, state),
      )

      expect(yields.length).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.setImmediate = originalSetImmediate
    }
  })
})
