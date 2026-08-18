import { decode } from '@msgpack/msgpack'
import { applyProjection, type ResolvedProjection } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import type { AnyDocument } from '../../types/schema'
import type { AllocationTable } from '../coordinator/types'
import { createFetchMessage, validateFetchResultPayload } from '../query/codec'
import { selectReplica } from '../query/selection'
import type { DistributedQueryResult } from '../query/types'
import type { FetchDocumentId, TransportMessage } from '../transport/types'
import type { ClusterLocalEngine } from './local-engine'
import type { ClusterNodeConfig } from './types'
import { resolvePartitionId } from './write-routing'

export async function resolveNodeTargets(config: ClusterNodeConfig, targetNodeId: string): Promise<string[]> {
  const targets = [targetNodeId]
  const nodes = await config.coordinator.listNodes()
  const registration = nodes.find(node => node.nodeId === targetNodeId)
  if (registration !== undefined && registration.address.length > 0 && registration.address !== targetNodeId) {
    targets.push(registration.address)
  }
  return targets
}

export async function sendToNode(
  config: ClusterNodeConfig,
  targetNodeId: string,
  message: TransportMessage,
): Promise<TransportMessage> {
  const targets = await resolveNodeTargets(config, targetNodeId)
  let lastError: unknown
  for (const target of targets) {
    try {
      return await config.transport.send(target, message)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function fetchFieldsFor(projection: ResolvedProjection): string[] | null {
  if (projection.kind !== 'fields' || projection.include === null) return null
  return projection.include.map(path => path.join('.'))
}

export async function fetchDistributedDocuments<T>(
  config: ClusterNodeConfig,
  nodeId: string,
  engine: ClusterLocalEngine,
  indexName: string,
  result: DistributedQueryResult,
  allocation: AllocationTable,
  projection: ResolvedProjection,
): Promise<Map<string, T>> {
  const documents = new Map<string, T>()
  if (projection.kind === 'none') return documents

  const partitionCount = allocation.assignments.size
  const nodeToDocumentIds = new Map<string, FetchDocumentId[]>()

  for (const entry of result.scored) {
    const partitionId = resolvePartitionId(entry.docId, partitionCount)
    const assignment = allocation.assignments.get(partitionId)
    if (assignment === undefined) {
      continue
    }
    const selectedNodeId = selectReplica(assignment, undefined, partitionId)
    if (selectedNodeId === null) {
      continue
    }
    let documentIds = nodeToDocumentIds.get(selectedNodeId)
    if (documentIds === undefined) {
      documentIds = []
      nodeToDocumentIds.set(selectedNodeId, documentIds)
    }
    documentIds.push({ docId: entry.docId, partitionId })
  }

  const fields = fetchFieldsFor(projection)
  for (const [targetNodeId, documentIds] of nodeToDocumentIds) {
    if (targetNodeId === nodeId) {
      for (const { docId } of documentIds) {
        const document = await engine.get(indexName, docId)
        if (document !== undefined) {
          documents.set(docId, applyProjection(document as AnyDocument, projection) as T)
        }
      }
      continue
    }

    const fetchMessage = createFetchMessage(
      {
        indexName,
        documentIds,
        fields,
        highlight: null,
      },
      nodeId,
    )
    const response = await sendToNode(config, targetNodeId, fetchMessage)
    const decoded = decode(response.payload)
    const payload = validateFetchResultPayload(decoded)
    for (const fetched of payload.documents) {
      documents.set(fetched.docId, applyProjection(fetched.document as AnyDocument, projection) as T)
    }
  }

  return documents
}

export async function readDistributedDocuments(
  config: ClusterNodeConfig,
  nodeId: string,
  engine: ClusterLocalEngine,
  indexName: string,
  docIds: readonly string[],
  allocation: AllocationTable,
): Promise<Map<string, AnyDocument>> {
  const partitionCount = allocation.assignments.size
  const nodeToDocumentIds = new Map<string, FetchDocumentId[]>()
  const unreachablePartitions = new Set<number>()

  for (const docId of new Set(docIds)) {
    const partitionId = resolvePartitionId(docId, partitionCount)
    const assignment = allocation.assignments.get(partitionId)
    const selectedNodeId = assignment === undefined ? null : selectReplica(assignment, undefined, partitionId)
    if (selectedNodeId === null) {
      unreachablePartitions.add(partitionId)
      continue
    }
    let documentIds = nodeToDocumentIds.get(selectedNodeId)
    if (documentIds === undefined) {
      documentIds = []
      nodeToDocumentIds.set(selectedNodeId, documentIds)
    }
    documentIds.push({ docId, partitionId })
  }

  if (unreachablePartitions.size > 0) {
    throw new NarsilError(
      ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
      `No active replica serves one or more partitions of index '${indexName}'`,
      { indexName, partitionIds: [...unreachablePartitions].sort((a, b) => a - b) },
    )
  }

  const documents = new Map<string, AnyDocument>()
  for (const [targetNodeId, documentIds] of nodeToDocumentIds) {
    if (targetNodeId === nodeId) {
      const local = await engine.getMultiple(
        indexName,
        documentIds.map(ref => ref.docId),
      )
      for (const [docId, document] of local) {
        documents.set(docId, document)
      }
      continue
    }

    const fetchMessage = createFetchMessage({ indexName, documentIds, fields: null, highlight: null }, nodeId)
    const response = await sendToNode(config, targetNodeId, fetchMessage)
    const payload = validateFetchResultPayload(decode(response.payload))
    for (const fetched of payload.documents) {
      documents.set(fetched.docId, fetched.document as AnyDocument)
    }
  }

  return documents
}
