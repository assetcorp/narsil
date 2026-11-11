import type { SegmentManifest } from './segment/manifest'
import type { PriorCheckpoint } from './segment/write'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'

export function priorForLayout(manifest: SegmentManifest | null, partitionCount: number): PriorCheckpoint {
  const checkpoints = new Map(manifest?.checkpoint.map(entry => [entry.partitionId, entry]))
  const partitions = new Map(manifest?.partitions.map(entry => [entry.partitionId, entry]))
  const prior: PriorCheckpoint = { checkpoint: [], partitions: [] }
  for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
    prior.checkpoint.push(
      checkpoints.get(partitionId) ?? { partitionId, lastSeqNo: 0, primaryTerm: SINGLE_NODE_PRIMARY_TERM },
    )
    prior.partitions.push(partitions.get(partitionId) ?? { partitionId, nextSegmentId: 0, segments: [] })
  }
  return prior
}
