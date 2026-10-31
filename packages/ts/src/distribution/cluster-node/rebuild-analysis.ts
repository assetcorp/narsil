import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import { getIndexMetadata, readIndexMetadataSnapshot } from '../cluster/index-metadata'
import type { ClusterCoordinator } from '../coordinator/types'
import { isRecord } from '../payload-guards'
import type {
  RebuildAnalysisPayload,
  RebuildAnalysisResultPayload,
  RespondFn,
  TransportMessage,
} from '../transport/types'
import { ClusterMessageTypes } from '../transport/types'
import type { ClusterLocalEngine } from './local-engine'
import { heldPartitionIdsOf } from './message-handler/partition-stores'
import { sendToNode } from './node-messaging'
import type { ClusterNodeConfig } from './types'

export interface ClusterRebuildDeps {
  nodeId: string
  config: ClusterNodeConfig
  engine: ClusterLocalEngine
}

function validateRebuildPayload(decoded: unknown): RebuildAnalysisPayload {
  if (
    !isRecord(decoded) ||
    typeof decoded.indexName !== 'string' ||
    decoded.indexName.length === 0 ||
    typeof decoded.indexUuid !== 'string' ||
    decoded.indexUuid.length === 0 ||
    (decoded.generation !== undefined && (!Number.isSafeInteger(decoded.generation) || Number(decoded.generation) < 1))
  ) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid RebuildAnalysisPayload: it needs an indexName, an indexUuid, and a generation of 1 or more where it carries one',
    )
  }
  return {
    indexName: decoded.indexName,
    indexUuid: decoded.indexUuid,
    ...(typeof decoded.generation === 'number' ? { generation: decoded.generation } : {}),
  }
}

async function buildHeldCopies(
  engine: ClusterLocalEngine,
  coordinator: ClusterCoordinator,
  payload: RebuildAnalysisPayload,
  generation: number,
): Promise<RebuildAnalysisResultPayload> {
  const { indexName, indexUuid } = payload
  const answer: RebuildAnalysisResultPayload = { indexName, rebuiltPartitions: [], generation }
  const localGeneration = engine.analysisGenerationOf(indexName)
  const localUuid = engine.indexUuidOf(indexName)
  if (localGeneration === undefined || (typeof localUuid === 'string' && localUuid !== indexUuid)) return answer
  if (localGeneration >= generation) return answer
  const snapshot = await readIndexMetadataSnapshot(coordinator, indexName)
  const settings = snapshot?.settings
  if (snapshot === null || snapshot.record.indexUuid !== indexUuid) return answer
  if ((settings?.analysisGeneration ?? 0) >= generation) return answer
  const pending = settings?.pendingAnalysis
  if (pending === undefined || pending.generation !== generation) {
    throw new NarsilError(
      ErrorCodes.ANALYSIS_CHANGE_REPLACED,
      `A later change replaced generation ${generation} of the analysis of index '${indexName}'`,
      { indexName },
    )
  }
  const { changeId: _changeId, ...named } = pending
  await engine.buildHeldAnalysis(indexName, named)
  return { ...answer, rebuiltPartitions: heldPartitionIdsOf(engine, indexName) }
}

function validateRebuildResult(decoded: unknown, indexName: string): RebuildAnalysisResultPayload {
  if (!isRecord(decoded) || decoded.indexName !== indexName || !Array.isArray(decoded.rebuiltPartitions)) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `A node answered a rebuild of index '${indexName}' with a malformed payload`,
      {
        indexName,
      },
    )
  }
  const rebuiltPartitions = decoded.rebuiltPartitions.filter(
    (partitionId): partitionId is number => Number.isInteger(partitionId) && partitionId >= 0,
  )
  return { indexName, rebuiltPartitions }
}

export async function rebuildLocalCopies(
  engine: ClusterLocalEngine,
  payload: RebuildAnalysisPayload,
): Promise<RebuildAnalysisResultPayload> {
  const { indexName, indexUuid } = payload
  const local = engine.listIndexes().find(index => index.name === indexName)
  if (
    local === undefined ||
    engine.indexUuidOf(indexName) !== indexUuid ||
    local.analysisStale !== true ||
    engine.pendingAnalysisGenerationOf(indexName) !== null
  ) {
    return { indexName, rebuiltPartitions: [] }
  }
  await engine.rebuildAnalysis(indexName)
  return { indexName, rebuiltPartitions: heldPartitionIdsOf(engine, indexName) }
}

export async function handleRebuildAnalysis(
  message: TransportMessage,
  respond: RespondFn,
  deps: { nodeId: string; engine: ClusterLocalEngine; coordinator: ClusterCoordinator },
): Promise<void> {
  const payload = validateRebuildPayload(decode(message.payload))
  const result =
    payload.generation === undefined
      ? await rebuildLocalCopies(deps.engine, payload)
      : await buildHeldCopies(deps.engine, deps.coordinator, payload, payload.generation)
  await respond({
    type: ClusterMessageTypes.REBUILD_ANALYSIS,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(result),
  })
}

async function stillRegistered(coordinator: ClusterCoordinator, nodeId: string): Promise<boolean> {
  return (await coordinator.listNodes()).some(node => node.nodeId === nodeId)
}

async function rebuildOn(deps: ClusterRebuildDeps, holder: string, payload: RebuildAnalysisPayload): Promise<void> {
  if (holder === deps.nodeId) {
    await rebuildLocalCopies(deps.engine, payload)
    return
  }
  const message: TransportMessage = {
    type: ClusterMessageTypes.REBUILD_ANALYSIS,
    sourceId: deps.nodeId,
    requestId: generateId(),
    payload: encode(payload),
  }
  for (;;) {
    if (!(await stillRegistered(deps.config.coordinator, holder))) {
      throw new NarsilError(
        ErrorCodes.QUERY_ROUTING_FAILED,
        `Node '${holder}' left the cluster before it rebuilt index '${payload.indexName}'`,
        { indexName: payload.indexName, nodeId: holder },
      )
    }
    try {
      const response = await sendToNode(deps.config, holder, message, {
        message: `Node '${holder}' did not answer the rebuild of index '${payload.indexName}'`,
        details: { indexName: payload.indexName },
      })
      const decoded: unknown = decode(response.payload)
      if (response.type.endsWith('.error')) {
        const code =
          isRecord(decoded) && typeof decoded.code === 'string' ? decoded.code : ErrorCodes.QUERY_ROUTING_FAILED
        throw new NarsilError(code, `Node '${holder}' failed the rebuild of index '${payload.indexName}'`, {
          indexName: payload.indexName,
          nodeId: holder,
        })
      }
      validateRebuildResult(decoded, payload.indexName)
      return
    } catch (error) {
      if (!(error instanceof NarsilError && error.code === ErrorCodes.QUERY_NODE_TIMEOUT)) throw error
    }
  }
}

export async function rebuildClusterAnalysis(deps: ClusterRebuildDeps, indexName: string): Promise<void> {
  const coordinator = deps.config.coordinator
  const metadata = await getIndexMetadata(coordinator, indexName)
  const table = await coordinator.getAllocation(indexName)
  if (metadata === null || table === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' has no metadata in the cluster`, {
      indexName,
    })
  }
  const holders = new Set<string>()
  for (const assignment of table.assignments.values()) {
    if (assignment.primary !== null) holders.add(assignment.primary)
    for (const replica of assignment.replicas) holders.add(replica)
    for (const replica of assignment.removingReplicas ?? []) holders.add(replica)
  }
  const payload: RebuildAnalysisPayload = { indexName, indexUuid: metadata.indexUuid }
  const holderIds = [...holders].sort()
  const outcomes = await Promise.allSettled(holderIds.map(holder => rebuildOn(deps, holder, payload)))
  const failedNodeIds = holderIds.filter((_, position) => outcomes[position]?.status === 'rejected')
  if (failedNodeIds.length > 0) {
    throw new NarsilError(
      ErrorCodes.QUERY_PARTIAL_FAILURE,
      `The rebuild of index '${indexName}' failed on ${failedNodeIds.length} node(s): ${failedNodeIds.join(', ')}`,
      { indexName, nodeIds: failedNodeIds },
    )
  }
}
