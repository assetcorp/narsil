import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { AnyDocument } from '../../types/schema'
import type { AllocationTable } from '../coordinator/types'
import { createFetchMessage, validateFetchResultPayload } from '../query/codec'
import { markNodeRejection, nodeRejectionOf, sendToEveryPartition } from '../query/failover'
import { copiesInSelectionOrder, type PartitionRouting, randomSelector } from '../query/selection'
import type { FetchDocumentId, TransportMessage } from '../transport/types'
import { ANSWER_DECODE_HEAP_BYTES_PER_PAYLOAD_BYTE, FETCH_GROUP_DOCUMENT_IDS } from './constants'
import { remoteErrorDetails } from './error-reply'
import type { ClusterLocalEngine } from './local-engine'
import { answerRefusalOf } from './memory/answer-room'
import { type SendFailureContext, sendThroughTargets } from './transport-failure'
import type { ClusterNodeConfig } from './types'
import { restoreVectorValues } from './vector-bytes'
import { resolvePartitionId } from './write-routing'

export async function resolveNodeTargets(config: ClusterNodeConfig, targetNodeId: string): Promise<string[]> {
  const targets = await resolveRegisteredTargets(config, targetNodeId)
  return targets.length > 0 ? targets : [targetNodeId]
}

export async function resolveRegisteredTargets(config: ClusterNodeConfig, targetNodeId: string): Promise<string[]> {
  const nodes = await config.coordinator.listNodes()
  const registration = nodes.find(node => node.nodeId === targetNodeId)
  if (registration === undefined) return []
  if (registration.address.length === 0 || registration.address === targetNodeId) return [targetNodeId]
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

export function readRejectionOf(
  decoded: Record<string, unknown>,
  targetNodeId: string,
  indexName: string,
): NarsilError {
  const details = { ...remoteErrorDetails(decoded.details), indexName, targetNodeId }
  return (
    nodeRejectionOf(decoded.code, decoded.message, details) ??
    new NarsilError(
      typeof decoded.code === 'string' ? decoded.code : ErrorCodes.QUERY_ROUTING_FAILED,
      typeof decoded.message === 'string'
        ? decoded.message
        : `Node '${targetNodeId}' rejected a read request for index '${indexName}'`,
      details,
    )
  )
}

export function refuseDecodeWithoutRoom(payload: Uint8Array): void {
  const refusal = answerRefusalOf(payload.byteLength * ANSWER_DECODE_HEAP_BYTES_PER_PAYLOAD_BYTE)
  if (refusal !== null) throw markNodeRejection(refusal)
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
      for (let start = 0; start < documentIds.length; start += FETCH_GROUP_DOCUMENT_IDS) {
        const chunk = documentIds.slice(start, start + FETCH_GROUP_DOCUMENT_IDS)
        const fetchMessage = createFetchMessage({ indexName, documentIds: chunk, fields, highlight: null }, nodeId)
        const response = await sendToNode(config, targetNodeId, fetchMessage, {
          message: `Node '${targetNodeId}' did not answer a document fetch for index '${indexName}'`,
          details: { indexName },
        })
        refuseDecodeWithoutRoom(response.payload)
        const decoded = decode(response.payload) as Record<string, unknown>
        if (response.type.endsWith('.error') || decoded.error === true) {
          throw readRejectionOf(decoded, targetNodeId, indexName)
        }
        const payload = validateFetchResultPayload(decoded)
        for (const fetched of payload.documents) {
          found.set(fetched.docId, restoreVectorValues(fetched.document) as AnyDocument)
        }
      }
    }

    for (const [docId, document] of found) documents.set(docId, document)
    return found
  })

  return documents
}

export async function readDocumentsFromCopies(
  config: ClusterNodeConfig,
  nodeId: string,
  engine: ClusterLocalEngine,
  indexName: string,
  docIds: readonly string[],
  allocation: AllocationTable,
  fields: string[] | null,
  requireEveryPartition: boolean,
): Promise<Map<string, AnyDocument>> {
  const documentRouting = routeDocumentIds(docIds, allocation)
  const unreachablePartitions = documentRouting.routing.unavailablePartitions

  if (requireEveryPartition && unreachablePartitions.length > 0) {
    throw new NarsilError(
      ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
      `No active replica serves one or more partitions of index '${indexName}'`,
      { indexName, partitionIds: [...unreachablePartitions].sort((a, b) => a - b) },
    )
  }

  return readFromCopies(config, nodeId, engine, indexName, documentRouting, fields)
}

export async function readDistributedDocuments(
  config: ClusterNodeConfig,
  nodeId: string,
  engine: ClusterLocalEngine,
  indexName: string,
  docIds: readonly string[],
  allocation: AllocationTable,
): Promise<Map<string, AnyDocument>> {
  return readDocumentsFromCopies(config, nodeId, engine, indexName, docIds, allocation, null, true)
}
