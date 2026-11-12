import type { AllocationTable } from '../../coordinator/types'
import { createCountMessage, validateCountResultPayload } from '../../query/codec'
import type { CountResultPayload, PartitionCountEntry } from '../../transport/types'
import { localCountAnswer } from './count-answer'
import { type ClusterReadDeps, sendReadRequest } from './scatter'

export type CopiesByPartition = Map<number, PartitionCountEntry[]>

function otherCopiesByNode(allocation: AllocationTable, readBy: ReadonlyMap<number, string>): Map<string, number[]> {
  const byNode = new Map<string, number[]>()
  for (const [partitionId, assignment] of allocation.assignments) {
    const copies = new Set(assignment.replicas)
    if (assignment.primary !== null) copies.add(assignment.primary)
    for (const nodeId of copies) {
      if (nodeId === readBy.get(partitionId)) continue
      const partitionIds = byNode.get(nodeId) ?? []
      partitionIds.push(partitionId)
      byNode.set(nodeId, partitionIds)
    }
  }
  return byNode
}

function answerOf(deps: ClusterReadDeps, indexName: string, nodeId: string, partitionIds: number[]) {
  if (nodeId === deps.nodeId) return localCountAnswer(deps.engine, indexName, partitionIds)
  const message = createCountMessage({ indexName, partitionIds }, deps.nodeId)
  return sendReadRequest(deps, nodeId, message, indexName, validateCountResultPayload)
}

function addAnswer(copies: CopiesByPartition, partitionIds: readonly number[], answer: CountResultPayload): boolean {
  const answered = new Map(answer.partitions.map(entry => [entry.partitionId, entry]))
  for (const partitionId of partitionIds) {
    const entry = answered.get(partitionId)
    if (entry === undefined) return false
    copies.get(partitionId)?.push(entry)
  }
  return true
}

export async function countsOfEveryCopy(
  deps: ClusterReadDeps,
  indexName: string,
  allocation: AllocationTable,
  readCopies: ReadonlyMap<number, PartitionCountEntry>,
  readBy: ReadonlyMap<number, string>,
): Promise<CopiesByPartition | null> {
  const copies: CopiesByPartition = new Map()
  for (const [partitionId, entry] of readCopies) copies.set(partitionId, [entry])
  const requests = [...otherCopiesByNode(allocation, readBy)].map(async ([nodeId, partitionIds]) => {
    const answer = await answerOf(deps, indexName, nodeId, partitionIds)
    return { partitionIds, answer }
  })
  let answers: { partitionIds: number[]; answer: CountResultPayload }[]
  try {
    answers = await Promise.all(requests)
  } catch {
    return null
  }
  for (const { partitionIds, answer } of answers) {
    if (!addAnswer(copies, partitionIds, answer)) return null
  }
  return copies
}

export function sumOf(
  entries: Iterable<PartitionCountEntry>,
  figure: (entry: PartitionCountEntry) => number | undefined,
): number | undefined {
  let total = 0
  for (const entry of entries) {
    const value = figure(entry)
    if (value === undefined) return undefined
    total += value
  }
  return total
}

export function savedBytesWithVectors(entry: PartitionCountEntry): number | undefined {
  if (entry.savedBytes === undefined || entry.vectorSavedBytes === undefined) return undefined
  return entry.savedBytes + entry.vectorSavedBytes
}
