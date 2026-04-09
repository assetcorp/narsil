import { fnv1a } from '../../core/hash'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import { type IndexMetadata, putIndexMetadata, validateIndexName } from '../cluster/index-metadata'
import type { AllocationConstraints, ClusterCoordinator } from '../coordinator/types'
import type { CreateIndexOptions } from './types'
import { DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'

const MAX_PARTITION_COUNT = 65_536
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

export async function routeInsert(
  indexName: string,
  document: AnyDocument,
  docId: string | undefined,
  nodeId: string,
  coordinator: ClusterCoordinator,
  engine: Narsil,
): Promise<string> {
  const resolvedDocId = docId ?? generateId()
  const table = await coordinator.getAllocation(indexName)

  if (table === null) {
    return engine.insert(indexName, document, resolvedDocId)
  }

  const partitionCount = table.assignments.size
  if (partitionCount === 0) {
    return engine.insert(indexName, document, resolvedDocId)
  }

  const partitionId = resolvePartitionId(resolvedDocId, partitionCount)
  const assignment = table.assignments.get(partitionId)

  if (assignment === undefined || assignment.primary === null) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `No primary assigned for partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId },
    )
  }

  if (assignment.primary === nodeId) {
    return engine.insert(indexName, document, resolvedDocId)
  }

  throw new NarsilError(
    ErrorCodes.QUERY_ROUTING_FAILED,
    `Write forwarding to remote primary is not yet implemented. Document targets partition ${partitionId}, primary is '${assignment.primary}', this node is '${nodeId}'`,
    { indexName, partitionId, primary: assignment.primary, thisNode: nodeId },
  )
}

export async function routeInsertBatch(
  indexName: string,
  documents: AnyDocument[],
  nodeId: string,
  coordinator: ClusterCoordinator,
  engine: Narsil,
): Promise<BatchResult> {
  const table = await coordinator.getAllocation(indexName)

  if (table === null || table.assignments.size === 0) {
    return engine.insertBatch(indexName, documents)
  }

  const partitionCount = table.assignments.size
  const failed: Array<{ docId: string; error: NarsilError }> = []
  const localInserts: Array<{ doc: AnyDocument; docId: string }> = []

  for (const doc of documents) {
    const docId = typeof doc.id === 'string' && doc.id.length > 0 ? doc.id : generateId()

    const partitionId = resolvePartitionId(docId, partitionCount)
    const assignment = table.assignments.get(partitionId)

    if (assignment === undefined || assignment.primary === null) {
      failed.push({
        docId,
        error: new NarsilError(
          ErrorCodes.QUERY_ROUTING_FAILED,
          `No primary assigned for partition ${partitionId} of index '${indexName}'`,
          { indexName, partitionId },
        ),
      })
      continue
    }

    if (assignment.primary !== nodeId) {
      failed.push({
        docId,
        error: new NarsilError(
          ErrorCodes.QUERY_ROUTING_FAILED,
          `Write forwarding to remote primary is not yet implemented`,
          { indexName, partitionId, primary: assignment.primary, thisNode: nodeId },
        ),
      })
      continue
    }

    localInserts.push({ doc, docId })
  }

  const succeeded: string[] = []

  const insertResults = await Promise.allSettled(
    localInserts.map(({ doc, docId }) => engine.insert(indexName, doc, docId)),
  )

  for (let i = 0; i < insertResults.length; i++) {
    const result = insertResults[i]
    if (result.status === 'fulfilled') {
      succeeded.push(result.value)
    } else {
      const docId = localInserts[i].docId
      const err = result.reason
      const narsilErr =
        err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err), { docId })
      failed.push({ docId, error: narsilErr })
    }
  }

  return { succeeded, failed }
}

export async function routeRemove(
  indexName: string,
  docId: string,
  nodeId: string,
  coordinator: ClusterCoordinator,
  engine: Narsil,
): Promise<void> {
  const table = await coordinator.getAllocation(indexName)

  if (table === null || table.assignments.size === 0) {
    return engine.remove(indexName, docId)
  }

  const partitionCount = table.assignments.size
  const partitionId = resolvePartitionId(docId, partitionCount)
  const assignment = table.assignments.get(partitionId)

  if (assignment === undefined || assignment.primary === null) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `No primary assigned for partition ${partitionId} of index '${indexName}'`,
      { indexName, partitionId },
    )
  }

  if (assignment.primary === nodeId) {
    return engine.remove(indexName, docId)
  }

  throw new NarsilError(
    ErrorCodes.QUERY_ROUTING_FAILED,
    `Write forwarding to remote primary is not yet implemented. Document targets partition ${partitionId}, primary is '${assignment.primary}', this node is '${nodeId}'`,
    { indexName, partitionId, primary: assignment.primary, thisNode: nodeId },
  )
}

export async function routeRemoveBatch(
  indexName: string,
  docIds: string[],
  nodeId: string,
  coordinator: ClusterCoordinator,
  engine: Narsil,
): Promise<BatchResult> {
  const table = await coordinator.getAllocation(indexName)

  if (table === null || table.assignments.size === 0) {
    return engine.removeBatch(indexName, docIds)
  }

  const partitionCount = table.assignments.size
  const failed: Array<{ docId: string; error: NarsilError }> = []
  const localDocIds: string[] = []

  for (const docId of docIds) {
    const partitionId = resolvePartitionId(docId, partitionCount)
    const assignment = table.assignments.get(partitionId)

    if (assignment === undefined || assignment.primary === null) {
      failed.push({
        docId,
        error: new NarsilError(
          ErrorCodes.QUERY_ROUTING_FAILED,
          `No primary assigned for partition ${partitionId} of index '${indexName}'`,
          { indexName, partitionId },
        ),
      })
      continue
    }

    if (assignment.primary !== nodeId) {
      failed.push({
        docId,
        error: new NarsilError(
          ErrorCodes.QUERY_ROUTING_FAILED,
          `Write forwarding to remote primary is not yet implemented`,
          { indexName, partitionId, primary: assignment.primary, thisNode: nodeId },
        ),
      })
      continue
    }

    localDocIds.push(docId)
  }

  if (localDocIds.length === 0) {
    return { succeeded: [], failed }
  }

  const batchResult = await engine.removeBatch(indexName, localDocIds)
  return {
    succeeded: batchResult.succeeded,
    failed: [...failed, ...batchResult.failed],
  }
}
