import { decode, encode } from '@msgpack/msgpack'
import { fnv1a } from '../../core/hash'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import { type IndexMetadata, putIndexMetadata, validateIndexName } from '../cluster/index-metadata'
import type { AllocationConstraints, ClusterCoordinator } from '../coordinator/types'
import { createForwardMessage } from '../replication/codec'
import type { ForwardPayload, NodeTransport } from '../transport/types'
import type { CreateIndexOptions } from './types'
import { DEFAULT_PARTITION_COUNT, DEFAULT_REPLICATION_FACTOR } from './types'

export interface WriteRoutingDeps {
  nodeId: string
  coordinator: ClusterCoordinator
  engine: Narsil
  transport: NodeTransport
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>
}

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

export async function routeInsert(
  indexName: string,
  document: AnyDocument,
  docId: string | undefined,
  deps: WriteRoutingDeps,
): Promise<string> {
  const resolvedDocId = docId ?? generateId()
  const table = await deps.coordinator.getAllocation(indexName)

  if (table === null) {
    return deps.engine.insert(indexName, document, resolvedDocId)
  }

  const partitionCount = table.assignments.size
  if (partitionCount === 0) {
    return deps.engine.insert(indexName, document, resolvedDocId)
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

  if (assignment.primary === deps.nodeId) {
    return deps.engine.insert(indexName, document, resolvedDocId)
  }

  return forwardInsertToRemote(indexName, document, resolvedDocId, assignment.primary, deps)
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
  const localInserts: Array<{ doc: AnyDocument; docId: string }> = []
  const remoteInserts: Array<{ doc: AnyDocument; docId: string; primaryNodeId: string }> = []

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

    if (assignment.primary === deps.nodeId) {
      localInserts.push({ doc, docId })
    } else {
      remoteInserts.push({ doc, docId, primaryNodeId: assignment.primary })
    }
  }

  const succeeded: string[] = []

  const localResults = await Promise.allSettled(
    localInserts.map(({ doc, docId }) => deps.engine.insert(indexName, doc, docId)),
  )

  for (let i = 0; i < localResults.length; i++) {
    const result = localResults[i]
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

  const remoteResults = await Promise.allSettled(
    remoteInserts.map(({ doc, docId, primaryNodeId }) =>
      forwardInsertToRemote(indexName, doc, docId, primaryNodeId, deps),
    ),
  )

  for (let i = 0; i < remoteResults.length; i++) {
    const result = remoteResults[i]
    if (result.status === 'fulfilled') {
      succeeded.push(result.value)
    } else {
      const docId = remoteInserts[i].docId
      const err = result.reason
      const narsilErr =
        err instanceof NarsilError ? err : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { docId })
      failed.push({ docId, error: narsilErr })
    }
  }

  return { succeeded, failed }
}

export async function routeRemove(indexName: string, docId: string, deps: WriteRoutingDeps): Promise<void> {
  const table = await deps.coordinator.getAllocation(indexName)

  if (table === null || table.assignments.size === 0) {
    return deps.engine.remove(indexName, docId)
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

  if (assignment.primary === deps.nodeId) {
    return deps.engine.remove(indexName, docId)
  }

  return forwardRemoveToRemote(indexName, docId, assignment.primary, deps)
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
  const localDocIds: string[] = []
  const remoteRemoves: Array<{ docId: string; primaryNodeId: string }> = []

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

    if (assignment.primary === deps.nodeId) {
      localDocIds.push(docId)
    } else {
      remoteRemoves.push({ docId, primaryNodeId: assignment.primary })
    }
  }

  const succeeded: string[] = []

  if (localDocIds.length > 0) {
    const batchResult = await deps.engine.removeBatch(indexName, localDocIds)
    succeeded.push(...batchResult.succeeded)
    failed.push(...batchResult.failed)
  }

  const remoteResults = await Promise.allSettled(
    remoteRemoves.map(({ docId, primaryNodeId }) => forwardRemoveToRemote(indexName, docId, primaryNodeId, deps)),
  )

  for (let i = 0; i < remoteResults.length; i++) {
    const result = remoteResults[i]
    if (result.status === 'fulfilled') {
      succeeded.push(remoteRemoves[i].docId)
    } else {
      const docId = remoteRemoves[i].docId
      const err = result.reason
      const narsilErr =
        err instanceof NarsilError ? err : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { docId })
      failed.push({ docId, error: narsilErr })
    }
  }

  return { succeeded, failed }
}
