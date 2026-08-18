import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument, IndexConfig } from '../../../types/schema'
import {
  type IndexMetadata,
  MAX_PARTITION_COUNT,
  putIndexMetadata,
  validateIndexName,
} from '../../cluster/index-metadata'
import type { AllocationConstraints, ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import type { CreateIndexOptions } from '../types'
import { DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from '../types'
import { requireAssignedPrimary, resolvePartitionId, resolvePrimaryAssignment } from './assignment'
import { forwardInsertToRemote, forwardRemoveToRemote } from './forwarding'
import { applyPrimaryInsert, applyPrimaryRemove } from './primary-writes'
import type { WriteRoutingDeps } from './types'

export { resolvePartitionId } from './assignment'
export { applyForwardedWrite } from './primary-writes'
export type { WriteRoutingDeps } from './types'

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
    await engine.createIndex(name, {
      ...config,
      partitions: { ...config.partitions, maxPartitions: partitionCount },
    })
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
