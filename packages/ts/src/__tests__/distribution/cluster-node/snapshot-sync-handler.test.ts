import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import {
  createSnapshotSyncHandlerState,
  handleSnapshotSyncRequest,
  type SnapshotSyncHandlerState,
} from '../../../distribution/cluster-node/snapshot-sync-handler'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import {
  MAX_SNAPSHOT_SIZE_BYTES,
  SNAPSHOT_CHUNK_SIZE,
  SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
  SNAPSHOT_HEADER_SENTINEL_SEQNO,
} from '../../../distribution/replication/snapshot-constants'
import { ReplicationMessageTypes, type TransportMessage } from '../../../distribution/transport/types'
import { ErrorCodes } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { crc32 } from '../../../serialization/crc32'

interface MockEngineOptions {
  indexes?: Array<{ name: string }>
  snapshotBytes?: Uint8Array
  snapshotRejects?: Error
  snapshotDelayMs?: number
  snapshotCalls?: { value: number }
}

function makeMockEngine(options: MockEngineOptions = {}): Narsil {
  const indexes = options.indexes ?? [{ name: 'products' }]
  const engine = {
    listIndexes: vi.fn().mockReturnValue(indexes),
    snapshot: vi.fn().mockImplementation(async () => {
      if (options.snapshotCalls !== undefined) {
        options.snapshotCalls.value += 1
      }
      if (options.snapshotDelayMs !== undefined) {
        await new Promise(resolve => setTimeout(resolve, options.snapshotDelayMs))
      }
      if (options.snapshotRejects !== undefined) {
        throw options.snapshotRejects
      }
      return options.snapshotBytes ?? new Uint8Array(0)
    }),
  } as unknown as Narsil
  return engine
}

function makeAllocation(indexName: string, primary: string, replicas: string[]): AllocationTable {
  const assignment: PartitionAssignment = {
    primary,
    replicas,
    inSyncSet: [primary, ...replicas],
    state: 'ACTIVE',
    primaryTerm: 1,
  }
  const assignments = new Map<number, PartitionAssignment>()
  assignments.set(0, assignment)
  return {
    indexName,
    version: 1,
    replicationFactor: replicas.length,
    assignments,
  }
}

function makeCoordinator(allocation: AllocationTable | null): ClusterCoordinator {
  return {
    getAllocation: vi.fn().mockResolvedValue(allocation),
  } as unknown as ClusterCoordinator
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

describe('handleSnapshotSyncRequest', () => {
  it('emits SNAPSHOT_START, contiguous SNAPSHOT_CHUNK frames, and SNAPSHOT_END', async () => {
    const totalBytes = SNAPSHOT_CHUNK_SIZE * 2 + 1_000
    const snapshotBytes = new Uint8Array(totalBytes)
    for (let i = 0; i < totalBytes; i++) {
      snapshotBytes[i] = i % 256
    }
    const engine = makeMockEngine({ snapshotBytes })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()
    const expectedChecksum = crc32(snapshotBytes)

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    const expectedChunkCount = Math.ceil(totalBytes / SNAPSHOT_CHUNK_SIZE)
    expect(responses.length).toBe(1 + expectedChunkCount + 1)

    const first = responses[0]
    expect(first.type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
    expect(first.sourceId).toBe('primary')
    expect(first.requestId).toBe('req-1')
    const startDecoded = decode(first.payload) as {
      header: { indexName: string; checksum: number; partitionId: number; lastSeqNo: number; primaryTerm: number }
      totalBytes: number
    }
    expect(startDecoded.header.indexName).toBe('products')
    expect(startDecoded.header.checksum).toBe(expectedChecksum)
    expect(startDecoded.header.partitionId).toBe(SNAPSHOT_HEADER_SENTINEL_PARTITION_ID)
    expect(startDecoded.header.lastSeqNo).toBe(SNAPSHOT_HEADER_SENTINEL_SEQNO)
    expect(startDecoded.header.primaryTerm).toBe(1)
    expect(startDecoded.totalBytes).toBe(totalBytes)

    let observedOffset = 0
    for (let i = 1; i <= expectedChunkCount; i++) {
      const chunkMsg = responses[i]
      expect(chunkMsg.type).toBe(ReplicationMessageTypes.SNAPSHOT_CHUNK)
      const chunkDecoded = decode(chunkMsg.payload) as {
        partitionId: number
        indexName: string
        offset: number
        data: Uint8Array
      }
      expect(chunkDecoded.partitionId).toBe(SNAPSHOT_HEADER_SENTINEL_PARTITION_ID)
      expect(chunkDecoded.indexName).toBe('products')
      expect(chunkDecoded.offset).toBe(observedOffset)
      observedOffset += chunkDecoded.data.byteLength
    }
    expect(observedOffset).toBe(totalBytes)

    const last = responses[responses.length - 1]
    expect(last.type).toBe(ReplicationMessageTypes.SNAPSHOT_END)
    const endDecoded = decode(last.payload) as {
      partitionId: number
      indexName: string
      totalBytes: number
      checksum: number
    }
    expect(endDecoded.partitionId).toBe(SNAPSHOT_HEADER_SENTINEL_PARTITION_ID)
    expect(endDecoded.indexName).toBe('products')
    expect(endDecoded.totalBytes).toBe(totalBytes)
    expect(endDecoded.checksum).toBe(expectedChecksum)
  })

  it('rejects unauthorized peers that are not assigned replicas', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(16) })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(
      makeRequest('products', 'req-1', 'intruder'),
      respond,
      makeDeps(engine, coordinator),
    )

    expect(responses.length).toBe(1)
    const envelope = responses[0]
    expect(envelope.type).toBe(`${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`)
    const decoded = decode(envelope.payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED)
  })

  it('rejects requests with an empty sourceId', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(0) })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products', 'req-1', ''), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
  })

  it('rejects when no allocation exists for the index', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(16) })
    const coordinator = makeCoordinator(null)
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED)
  })

  it('returns INDEX_NOT_FOUND when the index is not hosted locally', async () => {
    const engine = makeMockEngine({ indexes: [] })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const envelope = responses[0]
    expect(envelope.type).toBe(`${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`)
    const decoded = decode(envelope.payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_INDEX_NOT_FOUND)
  })

  it('returns TOO_LARGE when the snapshot exceeds the size limit', async () => {
    const snapshotBytes = {
      byteLength: MAX_SNAPSHOT_SIZE_BYTES + 1,
      subarray: () => new Uint8Array(0),
    } as unknown as Uint8Array
    const engine = makeMockEngine({ snapshotBytes })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(responses[0].type).toBe(`${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`)
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_TOO_LARGE)
  })

  it('returns SNAPSHOT_SYNC_REQUEST_INVALID when the request has no indexName', async () => {
    const engine = makeMockEngine()
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    const badRequest: TransportMessage = {
      type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
      sourceId: 'replica-node',
      requestId: 'req-x',
      payload: encode({}),
    }

    await handleSnapshotSyncRequest(badRequest, respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
  })

  it('returns SNAPSHOT_SYNC_REQUEST_INVALID when indexName is an empty string', async () => {
    const engine = makeMockEngine()
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    const badRequest: TransportMessage = {
      type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
      sourceId: 'replica-node',
      requestId: 'req-x',
      payload: encode({ indexName: '' }),
    }

    await handleSnapshotSyncRequest(badRequest, respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID)
  })

  it('emits a SNAPSHOT_SYNC_SNAPSHOT_FAILED envelope when engine.snapshot rejects', async () => {
    const engine = makeMockEngine({ snapshotRejects: new Error('disk full') })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(1)
    expect(responses[0].type).toBe(`${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`)
    const decoded = decode(responses[0].payload) as { code: string; message: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED)
    expect(decoded.message).toContain('disk full')
  })

  it('handles an empty snapshot by emitting SNAPSHOT_START and SNAPSHOT_END only', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(0) })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const { respond, responses } = collectResponses()

    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator))

    expect(responses.length).toBe(2)
    expect(responses[0].type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
    expect(responses[1].type).toBe(ReplicationMessageTypes.SNAPSHOT_END)
  })

  it('deduplicates concurrent requesters for the same index against a single snapshot build', async () => {
    const totalBytes = 1_024
    const snapshotBytes = new Uint8Array(totalBytes)
    const snapshotCalls = { value: 0 }
    const engine = makeMockEngine({ snapshotBytes, snapshotDelayMs: 40, snapshotCalls })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-a', 'replica-b']))
    const state = createSnapshotSyncHandlerState(4)

    const first = collectResponses()
    const second = collectResponses()

    await Promise.all([
      handleSnapshotSyncRequest(
        makeRequest('products', 'req-a', 'replica-a'),
        first.respond,
        makeDeps(engine, coordinator, state),
      ),
      handleSnapshotSyncRequest(
        makeRequest('products', 'req-b', 'replica-b'),
        second.respond,
        makeDeps(engine, coordinator, state),
      ),
    ])

    expect(snapshotCalls.value).toBe(1)
    expect(first.responses[0].type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
    expect(second.responses[0].type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
    expect(state.active).toBe(0)
    expect(state.cache.size).toBe(0)
  })

  it('returns SNAPSHOT_SYNC_CAPACITY_EXHAUSTED when the global cap is hit for a different index', async () => {
    const engine = makeMockEngine({ snapshotBytes: new Uint8Array(16) })
    const coordinator = makeCoordinator(makeAllocation('products', 'primary', ['replica-node']))
    const state = createSnapshotSyncHandlerState(1)
    state.active = 1

    const { respond, responses } = collectResponses()
    await handleSnapshotSyncRequest(makeRequest('products'), respond, makeDeps(engine, coordinator, state))

    expect(responses.length).toBe(1)
    const decoded = decode(responses[0].payload) as { code: string }
    expect(decoded.code).toBe(ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED)
  })
})
