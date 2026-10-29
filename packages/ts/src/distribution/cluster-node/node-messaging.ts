import { decode } from '@msgpack/msgpack'
import { applyProjection, type ResolvedProjection } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import type { AnyDocument } from '../../types/schema'
import type { AllocationTable } from '../coordinator/types'
import { createFetchMessage, validateFetchResultPayload } from '../query/codec'
import { MAX_FETCH_DOCUMENT_IDS } from '../query/constants'
import { sendToEveryPartition } from '../query/failover'
import { copiesInSelectionOrder, type PartitionRouting, randomSelector } from '../query/selection'
import type { DistributedQueryResult } from '../query/types'
import type { FetchDocumentId, TransportMessage } from '../transport/types'
import type { ClusterLocalEngine } from './local-engine'
import { type SendFailureContext, sendThroughTargets } from './transport-failure'
import type { ClusterNodeConfig } from './types'
import { resolvePartitionId } from './write-routing'

export async function resolveNodeTargets(config: ClusterNodeConfig, targetNodeId: string): Promise<string[]> {
  const nodes = await config.coordinator.listNodes()
  const registration = nodes.find(node => node.nodeId === targetNodeId)
  if (registration === undefined || registration.address.length === 0 || registration.address === targetNodeId) {
    return [targetNodeId]
  }
  return [registration.address, targetNodeId]
}

export async function sendToNode(
  config: ClusterNodeConfig,
  targetNodeId: string,
  message: TransportMessage,
  failure?: SendFailureContext,
): Promise<TransportMessage> {
  const targets = await resolveNodeTargets(config, targetNodeId)
  return sendThroughTargets(targets, target => config.transport.send(target, message), {
    message: failure?.message ?? `Node '${targetNodeId}' did not answer a cluster request`,
    details: { targetNodeId, ...failure?.details },
  })
}

function fetchFieldsFor(projection: ResolvedProjection): string[] | null {
  if (projection.kind !== 'fields' || projection.include === null) return null
  return projection.include.map(path => path.join('.'))
}

interface DocumentRouting {
  routing: PartitionRouting
  idsByPartition: Map<number, string[]>
}

function routeDocumentIds(docIds: Iterable<string>, allocation: AllocationTable): DocumentRouting {
  const partitionCount = allocation.assignments.size
  const routing: PartitionRouting = {
    nodeToPartitions: new Map(),
    copiesByPartition: new Map(),
    unavailablePartitions: [],
  }
  const idsByPartition = new Map<number, string[]>()

  for (const docId of new Set(docIds)) {
    const partitionId = resolvePartitionId(docId, partitionCount)
    const known = idsByPartition.get(partitionId)
    if (known !== undefined) {
      known.push(docId)
      continue
    }
    const assignment = allocation.assignments.get(partitionId)
    const copies = assignment === undefined ? [] : copiesInSelectionOrder(assignment, randomSelector, partitionId)
    const firstCopy = copies[0]
    if (firstCopy === undefined) {
      if (!routing.unavailablePartitions.includes(partitionId)) routing.unavailablePartitions.push(partitionId)
      continue
    }
    idsByPartition.set(partitionId, [docId])
    routing.copiesByPartition.set(partitionId, copies)
    const group = routing.nodeToPartitions.get(firstCopy)
    if (group === undefined) routing.nodeToPartitions.set(firstCopy, [partitionId])
    else group.push(partitionId)
  }

  return { routing, idsByPartition }
}

async function readFromCopies(
  config: ClusterNodeConfig,
  nodeId: string,
  engine: ClusterLocalEngine,
  indexName: string,
  documentRouting: DocumentRouting,
  fields: string[] | null,
): Promise<Map<string, AnyDocument>> {
  const documents = new Map<string, AnyDocument>()

  await sendToEveryPartition(documentRouting.routing, async (targetNodeId, partitionIds) => {
    const documentIds: FetchDocumentId[] = partitionIds.flatMap(partitionId =>
      (documentRouting.idsByPartition.get(partitionId) ?? []).map(docId => ({ docId, partitionId })),
    )
    const found = new Map<string, AnyDocument>()

    if (targetNodeId === nodeId) {
      const local = await engine.getMultiple(
        indexName,
        documentIds.map(ref => ref.docId),
      )
      for (const [docId, document] of local) found.set(docId, document)
    } else {
      for (let start = 0; start < documentIds.length; start += MAX_FETCH_DOCUMENT_IDS) {
        const chunk = documentIds.slice(start, start + MAX_FETCH_DOCUMENT_IDS)
        const fetchMessage = createFetchMessage({ indexName, documentIds: chunk, fields, highlight: null }, nodeId)
        const response = await sendToNode(config, targetNodeId, fetchMessage, {
          message: `Node '${targetNodeId}' did not answer a document fetch for index '${indexName}'`,
          details: { indexName },
        })
        const payload = validateFetchResultPayload(decode(response.payload))
        for (const fetched of payload.documents) found.set(fetched.docId, fetched.document as AnyDocument)
      }
    }

    for (const [docId, document] of found) documents.set(docId, document)
    return found
  })

  return documents
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

  const documentRouting = routeDocumentIds(
    result.scored.map(entry => entry.docId),
    allocation,
  )
  const found = await readFromCopies(config, nodeId, engine, indexName, documentRouting, fetchFieldsFor(projection))
  for (const [docId, document] of found) {
    documents.set(docId, applyProjection(document, projection) as T)
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
  const documentRouting = routeDocumentIds(docIds, allocation)
  const unreachablePartitions = documentRouting.routing.unavailablePartitions

  if (unreachablePartitions.length > 0) {
    throw new NarsilError(
      ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
      `No active replica serves one or more partitions of index '${indexName}'`,
      { indexName, partitionIds: [...unreachablePartitions].sort((a, b) => a - b) },
    )
  }

  return readFromCopies(config, nodeId, engine, indexName, documentRouting, null)
}
