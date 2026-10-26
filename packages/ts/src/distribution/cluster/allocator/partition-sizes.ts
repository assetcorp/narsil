import { ESTIMATED_PARTITION_BYTES } from '../constants'
import type { NodeRegistration, PartitionAssignment } from './types'

export interface PartitionSizes {
  sizeOf(partitionId: number): number
  reports(nodeId: string, partitionId: number): boolean
  heldBytesOf(nodeId: string, assignments: Map<number, PartitionAssignment>): number
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function reportedEntriesOf(node: NodeRegistration): Array<{ indexName: string; partitionId: number; bytes: number }> {
  const reported = node.partitionBytes
  if (!Array.isArray(reported)) {
    return []
  }
  const entries: Array<{ indexName: string; partitionId: number; bytes: number }> = []
  for (const index of reported) {
    if (index === null || typeof index !== 'object' || typeof index.indexName !== 'string') {
      continue
    }
    if (!Array.isArray(index.partitions)) {
      continue
    }
    for (const pair of index.partitions) {
      if (!Array.isArray(pair) || !Number.isSafeInteger(pair[0]) || pair[0] < 0 || !isByteCount(pair[1])) {
        continue
      }
      entries.push({ indexName: index.indexName, partitionId: pair[0], bytes: pair[1] })
    }
  }
  return entries
}

export function readPartitionSizes(nodes: NodeRegistration[], indexName: string): PartitionSizes {
  const largestByPartition = new Map<number, number>()
  const reportedByNode = new Map<string, Set<number>>()
  const reportedBytesByNode = new Map<string, number>()

  for (const node of nodes) {
    const reportedHere = new Set<number>()
    let reportedBytes = 0
    for (const entry of reportedEntriesOf(node)) {
      reportedBytes += entry.bytes
      if (entry.indexName !== indexName) {
        continue
      }
      reportedHere.add(entry.partitionId)
      largestByPartition.set(entry.partitionId, Math.max(largestByPartition.get(entry.partitionId) ?? 0, entry.bytes))
    }
    reportedByNode.set(node.nodeId, reportedHere)
    reportedBytesByNode.set(node.nodeId, reportedBytes)
  }

  function sizeOf(partitionId: number): number {
    return largestByPartition.get(partitionId) ?? ESTIMATED_PARTITION_BYTES
  }

  function reports(nodeId: string, partitionId: number): boolean {
    return reportedByNode.get(nodeId)?.has(partitionId) ?? false
  }

  return {
    sizeOf,
    reports,
    heldBytesOf(nodeId, assignments) {
      let heldBytes = reportedBytesByNode.get(nodeId) ?? 0
      for (const [partitionId, assignment] of assignments) {
        const holdsCopy = assignment.primary === nodeId || assignment.replicas.includes(nodeId)
        if (holdsCopy && !reports(nodeId, partitionId)) {
          heldBytes += sizeOf(partitionId)
        }
      }
      return heldBytes
    },
  }
}
