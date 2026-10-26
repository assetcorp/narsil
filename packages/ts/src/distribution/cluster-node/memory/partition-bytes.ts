import type { IndexPartitionBytes } from '../../coordinator/types'
import {
  PARTITION_BYTES_ENTRY_BYTES,
  PARTITION_BYTES_INDEX_OVERHEAD_BYTES,
  PARTITION_BYTES_REPORT_BUDGET_BYTES,
} from '../constants'
import type { ClusterLocalEngine } from '../local-engine'

interface PartitionSize {
  indexName: string
  partitionId: number
  bytes: number
}

function heldPartitionSizes(engine: ClusterLocalEngine, indexName: string): PartitionSize[] {
  const held = new Set(engine.heldPartitionsOf(indexName) ?? [])
  if (held.size === 0) {
    return []
  }
  const partitions = engine.getPartitionStats(indexName)
  const indexBytes = engine.getStats(indexName).estimatedMemoryBytes
  let partitionBytes = 0
  let documents = 0
  for (const partition of partitions) {
    partitionBytes += partition.estimatedMemoryBytes
    documents += partition.documentCount
  }
  const sharedBytes = Math.max(0, indexBytes - partitionBytes)
  const sizes: PartitionSize[] = []
  for (const partition of partitions) {
    if (!held.has(partition.partitionId)) {
      continue
    }
    const share = documents > 0 ? (sharedBytes * partition.documentCount) / documents : 0
    sizes.push({
      indexName,
      partitionId: partition.partitionId,
      bytes: Math.round(partition.estimatedMemoryBytes + share),
    })
  }
  return sizes
}

function largestWithinBudget(sizes: PartitionSize[]): PartitionSize[] {
  const ordered = [...sizes].sort((left, right) => right.bytes - left.bytes)
  const reportedIndexes = new Set<string>()
  const kept: PartitionSize[] = []
  let budgetBytes = PARTITION_BYTES_REPORT_BUDGET_BYTES
  for (const size of ordered) {
    const indexCost = reportedIndexes.has(size.indexName)
      ? 0
      : PARTITION_BYTES_INDEX_OVERHEAD_BYTES + Buffer.byteLength(size.indexName)
    const cost = indexCost + PARTITION_BYTES_ENTRY_BYTES
    if (cost > budgetBytes) {
      break
    }
    budgetBytes -= cost
    reportedIndexes.add(size.indexName)
    kept.push(size)
  }
  return kept
}

export function collectPartitionBytes(engine: ClusterLocalEngine): IndexPartitionBytes[] {
  const sizes: PartitionSize[] = []
  for (const index of engine.listIndexes()) {
    try {
      sizes.push(...heldPartitionSizes(engine, index.name))
    } catch {}
  }

  const byIndex = new Map<string, IndexPartitionBytes>()
  for (const size of largestWithinBudget(sizes)) {
    let entry = byIndex.get(size.indexName)
    if (entry === undefined) {
      entry = { indexName: size.indexName, partitions: [] }
      byIndex.set(size.indexName, entry)
    }
    entry.partitions.push([size.partitionId, size.bytes])
  }
  for (const entry of byIndex.values()) {
    entry.partitions.sort((left, right) => left[0] - right[0])
  }
  return [...byIndex.values()]
}
