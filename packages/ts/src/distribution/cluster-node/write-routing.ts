import { decode, encode } from '@msgpack/msgpack'
import { fnv1a } from '../../core/hash'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import { CONTROLLER_LEASE_KEY } from '../cluster/controller/types'
import { type IndexMetadata, MAX_PARTITION_COUNT, putIndexMetadata, validateIndexName } from '../cluster/index-metadata'
import type { AllocationConstraints, ClusterCoordinator, PartitionAssignment } from '../coordinator/types'
import { createForwardMessage } from '../replication/codec'
import { requestInsyncRemoval } from '../replication/insync'
import { replicateToReplicas } from '../replication/primary'
import type { ReplicationLog, ReplicationLogEntry } from '../replication/types'
import type { ForwardPayload, NodeTransport } from '../transport/types'
import type { CreateIndexOptions } from './types'
import { DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'

export interface WriteRoutingDeps {
  nodeId: string
  coordinator: ClusterCoordinator
  engine: Narsil
  transport: NodeTransport
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  resetReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>
}

const MAX_REPLICATION_FACTOR = 255

function validateCreateIndexOptions(partitionCount: number, replicationFactor: number): void {
  if (!Number.isInteger(partitionCount) || partitionCount < 1 || partitionCount > MAX_PARTITION_COUNT) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `partitionCount must be an integer between 1 and ${MAX_PARTITION_COUNT}, received ${partitionCount}`,
      { partitionCount },
    )
  }

  if (!Number.isInteger(replicationFactor) || replicationFactor < 0 || replicationFactor > MAX_REPLICATION_FACTOR) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `replicationFactor must be an integer between 0 and ${MAX_REPLICATION_FACTOR}, received ${replicationFactor}`,
      { replicationFactor },
    )
  }
}

export async function routeCreateIndex(
  name: string,
  config: IndexConfig,
  options: CreateIndexOptions | undefined,
  coordinator: ClusterCoordinator,
  engine: Narsil,
): Promise<void> {
  validateIndexName(name)

  const partitionCount = options?.partitionCount ?? DEFAULT_PARTITION_COUNT
  const replicationFactor = options?.replicationFactor ?? DEFAULT_REPLICATION_FACTOR
  validateCreateIndexOptions(partitionCount, replicationFactor)

  const constraints: AllocationConstraints = {
    zoneAwareness: false,
    zoneAttribute: 'zone',
    maxShardsPerNode: null,
  }

  const metadata: IndexMetadata = {
    indexName: name,
    partitionCount,
    replicationFactor,
    constraints,
  }

  const stored = await putIndexMetadata(coordinator, metadata)
  if (!stored) {
    throw new NarsilError(
      ErrorCodes.INDEX_ALREADY_EXISTS,
      `Index '${name}' already exists in the cluster or a partial creation is pending`,
      { indexName: name },
    )
  }

  try {
    await coordinator.putSchema(name, config.schema)
    await engine.createIndex(name, config)
  } catch (createErr) {
    let cleanupFailed = false
    let cleanupError: unknown
    try {
      const currentBytes = await coordinator.get(`_narsil/index/${name}/config`)
      if (currentBytes !== null) {
        await coordinator.compareAndSet(`_narsil/index/${name}/config`, currentBytes, new Uint8Array(0))
      }
    } catch (cleanErr) {
      cleanupFailed = true
      cleanupError = cleanErr
    }

    if (cleanupFailed) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `Index creation for '${name}' failed and metadata cleanup also failed. The index may be in a partial state and require manual intervention.`,
        {
          indexName: name,
          createError: createErr instanceof Error ? createErr.message : String(createErr),
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
      )
    }

    throw createErr
  }
}

export function resolvePartitionId(docId: string, partitionCount: number): number {
  return fnv1a(docId) % partitionCount
}

async function forwardInsertToRemote(
  indexName: string,
  document: AnyDocument,
  docId: string,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
): Promise<string> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'insert',
    document: encode(document),
    updateFields: null,
  }
  const message = createForwardMessage(payload, deps.nodeId)
  const response = await sendToNode(primaryNodeId, message, deps)
  const decoded = decode(response.payload) as Record<string, unknown>
  if (typeof decoded.documentId !== 'string') {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `Remote primary returned invalid forward response for index '${indexName}'`,
      { indexName, primaryNodeId },
    )
  }
  return decoded.documentId
}

async function forwardRemoveToRemote(
  indexName: string,
  docId: string,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
): Promise<void> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'remove',
    document: null,
    updateFields: null,
  }
  const message = createForwardMessage(payload, deps.nodeId)
  await sendToNode(primaryNodeId, message, deps)
}

async function sendToNode(
  nodeId: string,
  message: ReturnType<typeof createForwardMessage>,
  deps: WriteRoutingDeps,
): Promise<Awaited<ReturnType<NodeTransport['send']>>> {
  const targets = await resolveNodeTargets(nodeId, deps)
  let lastError: unknown
  for (const target of targets) {
    try {
      return await deps.transport.send(target, message)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function resolveNodeTargets(nodeId: string, deps: WriteRoutingDeps): Promise<string[]> {
  if (deps.resolveNodeTargets === undefined) {
    return [nodeId]
  }
  const targets = await deps.resolveNodeTargets(nodeId)
  return targets.length > 0 ? targets : [nodeId]
}

interface PrimaryAssignmentResolution {
  partitionId: number
  assignment: PartitionAssignment & { primary: string }
}

function requireAssignedPrimary(
  assignment: PartitionAssignment | undefined,
  indexName: string,
  partitionId: number,
): PartitionAssignment & { primary: string } {
  if (assignment === undefined || assignment.primary === null) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `No primary assigned for partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId },
    )
  }

  return assignment as PartitionAssignment & { primary: string }
}

async function resolvePrimaryAssignment(
  indexName: string,
  docId: string,
  deps: WriteRoutingDeps,
  requireLocalPrimary: boolean,
): Promise<PrimaryAssignmentResolution | null> {
  const table = await deps.coordinator.getAllocation(indexName)

  if (table === null || table.assignments.size === 0) {
    if (requireLocalPrimary) {
      throw new NarsilError(
        ErrorCodes.QUERY_ROUTING_FAILED,
        `No allocation table is available for forwarded write to index '${indexName}'`,
        { indexName },
      )
    }
    return null
  }

  const partitionCount = table.assignments.size
  const partitionId = resolvePartitionId(docId, partitionCount)
  const assignment = requireAssignedPrimary(table.assignments.get(partitionId), indexName, partitionId)

  if (requireLocalPrimary && assignment.primary !== deps.nodeId) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `Node '${deps.nodeId}' is not primary for partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId, primaryNodeId: assignment.primary, localNodeId: deps.nodeId },
    )
  }

  return { partitionId, assignment }
}

function getInSyncReplicaTargets(assignment: PartitionAssignment, localNodeId: string): string[] {
  const configuredReplicas = new Set(assignment.replicas)
  const targets: string[] = []

  for (const nodeId of assignment.inSyncSet) {
    if (nodeId !== localNodeId && configuredReplicas.has(nodeId)) {
      targets.push(nodeId)
    }
  }

  return targets
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwWriteFailure(error: unknown): never {
  if (error instanceof Error) {
    throw error
  }
  throw new Error(String(error))
}

function createRollbackFailure(
  operation: 'insert' | 'remove',
  indexName: string,
  partitionId: number,
  documentId: string,
  originalError: unknown,
  rollbackError: unknown,
): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_ROLLBACK_FAILED,
    `Primary ${operation} for document '${documentId}' in index '${indexName}' failed before acknowledgement and local rollback also failed`,
    {
      operation,
      indexName,
      partitionId,
      documentId,
      originalError: errorMessage(originalError),
      rollbackError: errorMessage(rollbackError),
    },
  )
}

async function rollbackPrimaryInsert(
  indexName: string,
  partitionId: number,
  documentId: string,
  originalError: unknown,
  deps: WriteRoutingDeps,
): Promise<never> {
  try {
    await deps.engine.remove(indexName, documentId)
  } catch (rollbackError) {
    if (!(rollbackError instanceof NarsilError && rollbackError.code === ErrorCodes.DOC_NOT_FOUND)) {
      throw createRollbackFailure('insert', indexName, partitionId, documentId, originalError, rollbackError)
    }
  }

  throwWriteFailure(originalError)
}

async function rollbackPrimaryRemove(
  indexName: string,
  partitionId: number,
  documentId: string,
  previousDocument: AnyDocument | undefined,
  originalError: unknown,
  deps: WriteRoutingDeps,
): Promise<never> {
  if (previousDocument === undefined) {
    throw createRollbackFailure(
      'remove',
      indexName,
      partitionId,
      documentId,
      originalError,
      new Error('No local document snapshot was available for restore'),
    )
  }

  try {
    await deps.engine.insert(indexName, previousDocument, documentId)
  } catch (rollbackError) {
    throw createRollbackFailure('remove', indexName, partitionId, documentId, originalError, rollbackError)
  }

  throwWriteFailure(originalError)
}

async function assertPrimaryWriteAuthority(entry: ReplicationLogEntry, deps: WriteRoutingDeps): Promise<void> {
  const table = await deps.coordinator.getAllocation(entry.indexName)
  const currentAssignment = table?.assignments.get(entry.partitionId)
  const currentPrimaryNodeId = currentAssignment?.primary ?? null
  const currentPrimaryTerm = currentAssignment?.primaryTerm ?? null

  if (currentPrimaryNodeId === deps.nodeId && currentPrimaryTerm === entry.primaryTerm) {
    return
  }

  throw new NarsilError(
    ErrorCodes.QUERY_ROUTING_FAILED,
    `Primary authority changed before acknowledging write for index '${entry.indexName}' partition ${entry.partitionId}`,
    {
      indexName: entry.indexName,
      partitionId: entry.partitionId,
      localNodeId: deps.nodeId,
      expectedPrimaryTerm: entry.primaryTerm,
      currentPrimaryNodeId,
      currentPrimaryTerm,
    },
  )
}

function appendIndexReplicationEntry(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  documentId: string,
  document: AnyDocument,
  deps: WriteRoutingDeps,
): ReplicationLogEntry {
  const log = deps.getReplicationLog(indexName, partitionId)
  return log.append({
    primaryTerm: assignment.primaryTerm,
    operation: 'INDEX',
    partitionId,
    indexName,
    documentId,
    document: encode(document),
  })
}

function appendDeleteReplicationEntry(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  documentId: string,
  deps: WriteRoutingDeps,
): ReplicationLogEntry {
  const log = deps.getReplicationLog(indexName, partitionId)
  return log.append({
    primaryTerm: assignment.primaryTerm,
    operation: 'DELETE',
    partitionId,
    indexName,
    documentId,
    document: null,
  })
}

async function removeFailedReplicasFromInsync(
  entry: ReplicationLogEntry,
  failedReplicas: string[],
  deps: WriteRoutingDeps,
): Promise<void> {
  if (failedReplicas.length === 0) {
    return
  }

  const controllerNodeId = await deps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
      `Failed to remove replicas from in-sync set for index '${entry.indexName}': no active controller lease holder`,
      { indexName: entry.indexName, partitionId: entry.partitionId, failedReplicas },
    )
  }

  for (const replicaNodeId of failedReplicas) {
    const accepted = await requestInsyncRemovalWithTargets(
      entry.indexName,
      entry.partitionId,
      replicaNodeId,
      entry.primaryTerm,
      controllerNodeId,
      deps,
    )

    if (!accepted) {
      throw new NarsilError(
        ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
        `Controller rejected in-sync removal for replica '${replicaNodeId}' of index '${entry.indexName}' partition ${entry.partitionId}`,
        { indexName: entry.indexName, partitionId: entry.partitionId, replicaNodeId },
      )
    }
  }
}

async function requestInsyncRemovalWithTargets(
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  controllerNodeId: string,
  deps: WriteRoutingDeps,
): Promise<boolean> {
  const targets = await resolveNodeTargets(controllerNodeId, deps)
  let lastError: unknown

  for (const target of targets) {
    try {
      const result = await requestInsyncRemoval(
        indexName,
        partitionId,
        replicaNodeId,
        primaryTerm,
        target,
        deps.transport,
        deps.nodeId,
      )
      return result.accepted
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function replicateEntry(
  entry: ReplicationLogEntry,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<void> {
  const replicaTargets = getInSyncReplicaTargets(assignment, deps.nodeId)
  const result = await replicateToReplicas(entry, replicaTargets, deps.transport, deps.nodeId, deps.resolveNodeTargets)
  await removeFailedReplicasFromInsync(entry, result.failed, deps)
  await assertPrimaryWriteAuthority(entry, deps)
}

async function applyPrimaryInsert(
  indexName: string,
  document: AnyDocument,
  docId: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<string> {
  const insertedDocId = await deps.engine.insert(indexName, document, docId)
  const storedDocument = await deps.engine.get(indexName, insertedDocId)

  if (storedDocument === undefined) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Inserted document '${insertedDocId}' could not be read back for replication`,
      { indexName, documentId: insertedDocId, partitionId },
    )
  }

  try {
    const entry = appendIndexReplicationEntry(indexName, partitionId, assignment, insertedDocId, storedDocument, deps)
    await replicateEntry(entry, assignment, deps)
  } catch (error) {
    await rollbackPrimaryInsert(indexName, partitionId, insertedDocId, error, deps)
  }

  return insertedDocId
}

async function applyPrimaryRemove(
  indexName: string,
  docId: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<void> {
  const previousDocument = await deps.engine.get(indexName, docId)
  await deps.engine.remove(indexName, docId)
  try {
    const entry = appendDeleteReplicationEntry(indexName, partitionId, assignment, docId, deps)
    await replicateEntry(entry, assignment, deps)
  } catch (error) {
    await rollbackPrimaryRemove(indexName, partitionId, docId, previousDocument, error, deps)
  }
}

export async function applyForwardedWrite(payload: ForwardPayload, deps: WriteRoutingDeps): Promise<string> {
  const resolution = await resolvePrimaryAssignment(payload.indexName, payload.documentId, deps, true)
  if (resolution === null) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `No allocation table is available for forwarded write to index '${payload.indexName}'`,
      { indexName: payload.indexName },
    )
  }

  if (payload.operation === 'insert') {
    if (payload.document === null) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: insert requires a document')
    }
    const document = decode(payload.document) as AnyDocument
    return applyPrimaryInsert(
      payload.indexName,
      document,
      payload.documentId,
      resolution.partitionId,
      resolution.assignment,
      deps,
    )
  }

  if (payload.operation === 'remove') {
    await applyPrimaryRemove(payload.indexName, payload.documentId, resolution.partitionId, resolution.assignment, deps)
    return payload.documentId
  }

  throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Forward update operations are not supported yet')
}

export async function routeInsert(
  indexName: string,
  document: AnyDocument,
  docId: string | undefined,
  deps: WriteRoutingDeps,
): Promise<string> {
  const resolvedDocId = docId ?? generateId()
  const resolution = await resolvePrimaryAssignment(indexName, resolvedDocId, deps, false)

  if (resolution === null) {
    return deps.engine.insert(indexName, document, resolvedDocId)
  }

  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryInsert(indexName, document, resolvedDocId, resolution.partitionId, resolution.assignment, deps)
  }

  return forwardInsertToRemote(indexName, document, resolvedDocId, primaryNodeId, deps)
}

export async function routeInsertBatch(
  indexName: string,
  documents: AnyDocument[],
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  const table = await deps.coordinator.getAllocation(indexName)

  if (table === null || table.assignments.size === 0) {
    return deps.engine.insertBatch(indexName, documents)
  }

  const partitionCount = table.assignments.size
  const failed: Array<{ docId: string; error: NarsilError }> = []
  const routedInserts: Array<{
    doc: AnyDocument
    docId: string
    partitionId: number
    assignment: PartitionAssignment & { primary: string }
  }> = []

  for (const doc of documents) {
    const docId = typeof doc.id === 'string' && doc.id.length > 0 ? doc.id : generateId()

    const partitionId = resolvePartitionId(docId, partitionCount)
    const assignment = table.assignments.get(partitionId)

    try {
      const assignedPrimary = requireAssignedPrimary(assignment, indexName, partitionId)
      routedInserts.push({ doc, docId, partitionId, assignment: assignedPrimary })
    } catch (err) {
      failed.push({
        docId,
        error:
          err instanceof NarsilError
            ? err
            : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { indexName, partitionId }),
      })
    }
  }

  const succeeded: string[] = []

  for (const routed of routedInserts) {
    const primaryNodeId = routed.assignment.primary
    try {
      const insertedDocId =
        primaryNodeId === deps.nodeId
          ? await applyPrimaryInsert(indexName, routed.doc, routed.docId, routed.partitionId, routed.assignment, deps)
          : await forwardInsertToRemote(indexName, routed.doc, routed.docId, primaryNodeId, deps)

      succeeded.push(insertedDocId)
    } catch (err) {
      const fallbackCode =
        primaryNodeId === deps.nodeId ? ErrorCodes.DOC_VALIDATION_FAILED : ErrorCodes.QUERY_ROUTING_FAILED
      const narsilErr =
        err instanceof NarsilError ? err : new NarsilError(fallbackCode, String(err), { docId: routed.docId })
      failed.push({ docId: routed.docId, error: narsilErr })
    }
  }

  return { succeeded, failed }
}

export async function routeRemove(indexName: string, docId: string, deps: WriteRoutingDeps): Promise<void> {
  const resolution = await resolvePrimaryAssignment(indexName, docId, deps, false)

  if (resolution === null) {
    return deps.engine.remove(indexName, docId)
  }

  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryRemove(indexName, docId, resolution.partitionId, resolution.assignment, deps)
  }

  return forwardRemoveToRemote(indexName, docId, primaryNodeId, deps)
}

export async function routeRemoveBatch(
  indexName: string,
  docIds: string[],
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  const table = await deps.coordinator.getAllocation(indexName)

  if (table === null || table.assignments.size === 0) {
    return deps.engine.removeBatch(indexName, docIds)
  }

  const partitionCount = table.assignments.size
  const failed: Array<{ docId: string; error: NarsilError }> = []
  const routedRemoves: Array<{
    docId: string
    partitionId: number
    assignment: PartitionAssignment & { primary: string }
  }> = []

  for (const docId of docIds) {
    const partitionId = resolvePartitionId(docId, partitionCount)
    const assignment = table.assignments.get(partitionId)

    try {
      const assignedPrimary = requireAssignedPrimary(assignment, indexName, partitionId)
      routedRemoves.push({ docId, partitionId, assignment: assignedPrimary })
    } catch (err) {
      failed.push({
        docId,
        error:
          err instanceof NarsilError
            ? err
            : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { indexName, partitionId }),
      })
    }
  }

  const succeeded: string[] = []

  for (const routed of routedRemoves) {
    try {
      const primaryNodeId = routed.assignment.primary
      if (primaryNodeId === deps.nodeId) {
        await applyPrimaryRemove(indexName, routed.docId, routed.partitionId, routed.assignment, deps)
      } else {
        await forwardRemoveToRemote(indexName, routed.docId, primaryNodeId, deps)
      }
      succeeded.push(routed.docId)
    } catch (err) {
      const narsilErr =
        err instanceof NarsilError
          ? err
          : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { docId: routed.docId })
      failed.push({ docId: routed.docId, error: narsilErr })
    }
  }

  return { succeeded, failed }
}
