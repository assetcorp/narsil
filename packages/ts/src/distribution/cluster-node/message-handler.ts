import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { crc32 } from '../../serialization/crc32'
import type { QueryResult } from '../../types/results'
import type { FacetConfig, QueryParams } from '../../types/search'
import type { ClusterCoordinator } from '../coordinator/types'
import { validateFetchPayload, validateSearchPayload, validateStatsPayload } from '../query/codec'
import { createAckMessage, validateEntryPayload } from '../replication/codec'
import { validateReplicationEntry } from '../replication/replica'
import { decideSyncTier, validateSyncRequest } from '../replication/sync-primary'
import type {
  FetchResultPayload,
  ForwardPayload,
  SearchResultPayload,
  StatsResultPayload,
  SyncEntriesPayload,
  TransportMessage,
} from '../transport/types'
import { QueryMessageTypes, ReplicationMessageTypes } from '../transport/types'
import type { ClusterLocalEngine } from './local-engine'
import { authorizeSnapshotRequest } from './snapshot-auth'
import { createSingleResponseSink } from './snapshot-stream-writer'
import {
  handleSnapshotSyncRequest,
  type SnapshotHeaderMetadataProvider,
  type SnapshotSyncHandlerState,
  streamValidatedSnapshotRequest,
} from './snapshot-sync-handler'
import { applyForwardedWrite, type WriteRoutingDeps } from './write-routing'

export type TransportHandler = (
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
) => void | Promise<void>

export interface DataNodeHandlerDeps {
  nodeId: string
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  writeDeps: WriteRoutingDeps
  snapshotSyncState: SnapshotSyncHandlerState
  resolveHeaderMetadata?: SnapshotHeaderMetadataProvider
  isBootstrapSynced?: (indexName: string, partitionId: number) => boolean
}

export function createDataNodeHandler(deps: DataNodeHandlerDeps): TransportHandler {
  return async (message: TransportMessage, respond: (response: TransportMessage) => void): Promise<void> => {
    if (message.type === ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST) {
      await handleSnapshotSyncRequest(message, respond, {
        nodeId: deps.nodeId,
        engine: deps.engine,
        coordinator: deps.coordinator,
        state: deps.snapshotSyncState,
        resolveHeaderMetadata: deps.resolveHeaderMetadata,
      })
      return
    }

    try {
      switch (message.type) {
        case ReplicationMessageTypes.SYNC_REQUEST:
          await handleSyncRequestMessage(message, respond, deps)
          return
        case ReplicationMessageTypes.FORWARD:
          await handleForward(message, respond, deps)
          return
        case ReplicationMessageTypes.ENTRY:
          await handleReplicationEntry(message, respond, deps)
          return
        case QueryMessageTypes.SEARCH:
          await handleSearch(message, respond, deps)
          return
        case QueryMessageTypes.FETCH:
          await handleFetch(message, respond, deps)
          return
        case QueryMessageTypes.STATS:
          await handleStats(message, respond, deps)
          return
        default:
          return
      }
    } catch (err) {
      const errorPayload = encode({
        error: true,
        code: err instanceof NarsilError ? err.code : 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
      respond({
        type: `${message.type}.error`,
        sourceId: deps.nodeId,
        requestId: message.requestId,
        payload: errorPayload,
      })
    }
  }
}

async function handleSyncRequestMessage(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const request = validateSyncRequest(decode(message.payload))

  const authResult = await authorizeSnapshotRequest(deps.coordinator, request.indexName, message.sourceId)
  if (authResult.outcome === 'denied') {
    throw new NarsilError(authResult.code, authResult.reason, {
      indexName: request.indexName,
      partitionId: request.partitionId,
      sourceNodeId: message.sourceId,
    })
  }

  const table = await deps.coordinator.getAllocation(request.indexName)
  const assignment = table?.assignments.get(request.partitionId)
  if (assignment === undefined) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED,
      `No assignment exists for sync request partition ${request.partitionId} of index '${request.indexName}'`,
      { indexName: request.indexName, partitionId: request.partitionId },
    )
  }

  if (assignment.primary !== deps.nodeId) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED,
      `Node '${deps.nodeId}' is not primary for sync request partition ${request.partitionId} of index '${request.indexName}'`,
      {
        indexName: request.indexName,
        partitionId: request.partitionId,
        localNodeId: deps.nodeId,
        primaryNodeId: assignment.primary,
      },
    )
  }

  const sourceAssigned = assignment.primary === message.sourceId || assignment.replicas.includes(message.sourceId)
  if (!sourceAssigned) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED,
      `Node '${message.sourceId}' is not assigned to partition ${request.partitionId} of index '${request.indexName}'`,
      { indexName: request.indexName, partitionId: request.partitionId, sourceNodeId: message.sourceId },
    )
  }

  if (request.lastPrimaryTerm > assignment.primaryTerm) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      `Replica term ${request.lastPrimaryTerm} is newer than primary term ${assignment.primaryTerm}`,
      {
        indexName: request.indexName,
        partitionId: request.partitionId,
        lastPrimaryTerm: request.lastPrimaryTerm,
        primaryTerm: assignment.primaryTerm,
      },
    )
  }

  const log = deps.writeDeps.getReplicationLog(request.indexName, request.partitionId)
  const tier = decideSyncTier(log, request.lastSeqNo)
  if (tier === 'incremental') {
    sendSyncEntriesResponse(message, respond, deps, log.getEntriesFrom(request.lastSeqNo + 1))
    return
  }

  const snapshotSeqNo = log.committedSeqNo
  const sink = createSingleResponseSink(respond)
  await streamValidatedSnapshotRequest(
    message,
    sink,
    { indexName: request.indexName, partitionId: request.partitionId },
    {
      nodeId: deps.nodeId,
      engine: deps.engine,
      coordinator: deps.coordinator,
      state: deps.snapshotSyncState,
      resolveHeaderMetadata: deps.resolveHeaderMetadata,
    },
    {
      metadata: {
        partitionId: request.partitionId,
        lastSeqNo: snapshotSeqNo,
        primaryTerm: assignment.primaryTerm,
      },
      closeOnEnd: false,
      disableBuildCache: true,
      buildSnapshot: async () => {
        const bytes = await deps.engine.serializeReplicationPartition(request.indexName, request.partitionId)
        return { bytes, checksum: crc32(bytes) }
      },
      afterSnapshot: trailingSink => {
        const entries = log.getEntriesFrom(snapshotSeqNo + 1)
        sendSyncEntriesResponse(message, trailingSink, deps, entries)
      },
    },
  )
}

function sendSyncEntriesResponse(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
  entries: SyncEntriesPayload['entries'],
): void {
  const payload: SyncEntriesPayload = {
    entries,
    isLast: true,
  }
  respond({
    type: ReplicationMessageTypes.SYNC_ENTRIES,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(payload),
  })
}

async function handleForward(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as Record<string, unknown>
  const payload = validateForwardPayload(decoded)
  const documentId = await applyForwardedWrite(payload, deps.writeDeps)

  respond({
    type: ReplicationMessageTypes.FORWARD,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode({ documentId, success: true }),
  })
}

async function handleReplicationEntry(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateEntryPayload(decode(message.payload))
  const { entry } = payload

  const table = await deps.coordinator.getAllocation(entry.indexName)
  if (table === null) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `No allocation table is available for replication entry on index '${entry.indexName}'`,
      { indexName: entry.indexName, partitionId: entry.partitionId },
    )
  }

  const assignment = table.assignments.get(entry.partitionId)
  if (assignment === undefined) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `No assignment exists for replication entry partition ${entry.partitionId} of index '${entry.indexName}'`,
      { indexName: entry.indexName, partitionId: entry.partitionId },
    )
  }

  if (assignment.primary !== message.sourceId) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Replication entry for index '${entry.indexName}' partition ${entry.partitionId} came from a non-primary node`,
      {
        indexName: entry.indexName,
        partitionId: entry.partitionId,
        sourceNodeId: message.sourceId,
        primaryNodeId: assignment.primary,
      },
    )
  }

  if (assignment.primaryTerm !== entry.primaryTerm) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Replication entry term ${entry.primaryTerm} does not match allocation term ${assignment.primaryTerm}`,
      { indexName: entry.indexName, partitionId: entry.partitionId },
    )
  }

  if (!assignment.replicas.includes(deps.nodeId) || !assignment.inSyncSet.includes(deps.nodeId)) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Node '${deps.nodeId}' is not an in-sync replica for index '${entry.indexName}' partition ${entry.partitionId}`,
      { indexName: entry.indexName, partitionId: entry.partitionId, nodeId: deps.nodeId },
    )
  }

  let log = deps.writeDeps.getReplicationLog(entry.indexName, entry.partitionId)
  const existing = log.getEntry(entry.seqNo)
  if (existing !== undefined) {
    if (existing.checksum !== entry.checksum) {
      throw new NarsilError(
        ErrorCodes.REPLICATION_ENTRY_INVALID,
        `Conflicting replication entry at sequence number ${entry.seqNo}`,
        { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo },
      )
    }
    respond(createAckMessage(entry.seqNo, entry.partitionId, entry.indexName, deps.nodeId, message.requestId))
    return
  }

  const expectedSeqNo = (log.newestSeqNo ?? 0) + 1
  if (entry.seqNo !== expectedSeqNo) {
    const canSeedFromCompletedBootstrap =
      log.entryCount === 0 &&
      entry.seqNo > expectedSeqNo &&
      deps.isBootstrapSynced?.(entry.indexName, entry.partitionId) === true

    if (!canSeedFromCompletedBootstrap) {
      throw new NarsilError(
        ErrorCodes.REPLICATION_ENTRY_INVALID,
        `Out-of-order replication entry ${entry.seqNo}; expected ${expectedSeqNo}`,
        { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo, expectedSeqNo },
      )
    }

    deps.writeDeps.resetReplicationLog(entry.indexName, entry.partitionId, entry.seqNo, entry.primaryTerm)
    log = deps.writeDeps.getReplicationLog(entry.indexName, entry.partitionId)
  }

  const validation = validateReplicationEntry(entry, assignment.primaryTerm, log)
  if (!validation.valid) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Invalid replication entry ${entry.seqNo}: ${validation.error ?? 'unknown validation error'}`,
      { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo },
    )
  }

  await deps.engine.applyReplicationEntry(entry)
  log.appendCommitted(entry)

  respond(createAckMessage(entry.seqNo, entry.partitionId, entry.indexName, deps.nodeId, message.requestId))
}

async function handleSearch(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateSearchPayload(decoded)

  const queryParams: QueryParams = {
    term: payload.params.term ?? undefined,
    fields: payload.params.fields ?? undefined,
    filters: payload.params.filters ?? undefined,
    boost: payload.params.boost ?? undefined,
    scoring: payload.params.scoring,
    tolerance: payload.params.tolerance ?? undefined,
    minScore: payload.params.threshold ?? undefined,
    limit: payload.params.limit,
    offset: payload.params.offset,
    searchAfter: payload.params.searchAfter ?? undefined,
    sort: convertWireSortToLocal(payload.params.sort),
    group:
      payload.params.group !== null
        ? { fields: [payload.params.group.field], maxPerGroup: payload.params.group.maxPerGroup }
        : undefined,
    facets: convertWireFacetsToLocal(payload.params.facets, payload.facetShardSize ?? payload.params.facetSize),
    vector:
      payload.params.vector !== null
        ? {
            field: payload.params.vector.field,
            value: payload.params.vector.value ?? undefined,
            text: payload.params.vector.text ?? undefined,
            similarity: payload.params.vector.similarity ?? undefined,
          }
        : undefined,
    hybrid:
      payload.params.hybrid !== null
        ? { strategy: payload.params.hybrid.strategy, k: payload.params.hybrid.k, alpha: payload.params.hybrid.alpha }
        : undefined,
  }

  const queryResult = await deps.engine.query(payload.indexName, queryParams)

  const scored = queryResult.hits.map(hit => ({
    docId: hit.id,
    score: hit.score,
    sortValues: null,
  }))

  const results = payload.partitionIds.map(partitionId => ({
    partitionId,
    scored: partitionId === payload.partitionIds[0] ? scored : [],
    totalHits: partitionId === payload.partitionIds[0] ? queryResult.count : 0,
  }))

  const resultPayload: SearchResultPayload = { results, facets: convertLocalFacetsToWire(queryResult.facets) }

  respond({
    type: QueryMessageTypes.SEARCH_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(resultPayload),
  })
}

async function handleFetch(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateFetchPayload(decoded)

  const documents = []
  for (const docRef of payload.documentIds) {
    const doc = await deps.engine.get(payload.indexName, docRef.docId)
    if (doc !== undefined) {
      documents.push({
        docId: docRef.docId,
        document: doc as Record<string, unknown>,
        highlights: null,
      })
    }
  }

  const resultPayload: FetchResultPayload = { documents }

  respond({
    type: QueryMessageTypes.FETCH_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(resultPayload),
  })
}

async function handleStats(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateStatsPayload(decoded)

  const stats = deps.engine.getStats(payload.indexName)
  const resultPayload: StatsResultPayload = {
    totalDocuments: stats.documentCount,
    docFrequencies: {},
    totalFieldLengths: {},
  }

  respond({
    type: QueryMessageTypes.STATS_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(resultPayload),
  })
}

export function validateForwardPayload(decoded: unknown): ForwardPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: expected an object')
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.indexName !== 'string' || record.indexName.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "indexName" must be a non-empty string')
  }
  if (typeof record.documentId !== 'string' || record.documentId.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "documentId" must be a non-empty string')
  }
  if (record.operation !== 'insert' && record.operation !== 'remove' && record.operation !== 'update') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid ForwardPayload: "operation" must be "insert", "remove", or "update"',
    )
  }
  return decoded as unknown as ForwardPayload
}

function convertWireSortToLocal(
  wireSort: Array<{ field: string; direction: 'asc' | 'desc' }> | null,
): Record<string, 'asc' | 'desc'> | undefined {
  if (wireSort === null || wireSort.length === 0) {
    return undefined
  }
  const result: Record<string, 'asc' | 'desc'> = {}
  for (const entry of wireSort) {
    result[entry.field] = entry.direction
  }
  return result
}

function convertWireFacetsToLocal(facets: string[] | null, limit: number | null): FacetConfig | undefined {
  if (facets === null || facets.length === 0) {
    return undefined
  }
  const result: FacetConfig = {}
  for (const field of facets) {
    result[field] = limit !== null ? { limit } : {}
  }
  return result
}

function convertLocalFacetsToWire(
  facets: QueryResult['facets'],
): Record<string, Array<{ value: string; count: number }>> | null {
  if (facets === undefined) {
    return null
  }
  const result: Record<string, Array<{ value: string; count: number }>> = {}
  for (const [field, facet] of Object.entries(facets)) {
    result[field] = Object.entries(facet.values).map(([value, count]) => ({ value, count }))
  }
  return result
}
