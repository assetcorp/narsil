import { decode } from '@msgpack/msgpack'
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

export async function fetchDistributedDocuments<T>(
  config: ClusterNodeConfig,
  nodeId: string,
  engine: ClusterLocalEngine,
  indexName: string,
  result: DistributedQueryResult,
  allocation: AllocationTable,
): Promise<Map<string, T>> {
  const partitionCount = allocation.assignments.size
  const nodeToDocumentIds = new Map<string, FetchDocumentId[]>()

  for (const entry of result.scored) {
    const partitionId = resolvePartitionId(entry.docId, partitionCount)
    const assignment = allocation.assignments.get(partitionId)
    if (assignment === undefined) {
      continue
    }
    const selectedNodeId = selectReplica(assignment, nodeId, undefined, partitionId)
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

  const documents = new Map<string, T>()
  for (const [targetNodeId, documentIds] of nodeToDocumentIds) {
    if (targetNodeId === nodeId) {
      for (const { docId } of documentIds) {
        const document = await engine.get(indexName, docId)
        if (document !== undefined) {
          documents.set(docId, document as T)
        }
      }
      continue
    }

    const fetchMessage = createFetchMessage(
      {
        indexName,
        documentIds,
        fields: null,
        highlight: null,
      },
      nodeId,
    )
    const response = await sendToNode(config, targetNodeId, fetchMessage)
    const decoded = decode(response.payload)
    const payload = validateFetchResultPayload(decoded)
    for (const fetched of payload.documents) {
      documents.set(fetched.docId, fetched.document as T)
    }
  }

  return documents
}
