export interface TermStart {
  primaryTerm: number
  firstSeqNo: number
}

export interface PartitionCheckpoint {
  partitionId: number
  lastSeqNo: number
  primaryTerm: number
  termHistory?: TermStart[]
}

export function checkpointLastSeqNo(checkpoint: readonly PartitionCheckpoint[], partitionId: number): number {
  for (const c of checkpoint) {
    if (c.partitionId === partitionId) {
      return c.lastSeqNo
    }
  }
  return 0
}

export function checkpointPrimaryTerm(checkpoint: readonly PartitionCheckpoint[], partitionId: number): number {
  for (const c of checkpoint) {
    if (c.partitionId === partitionId) {
      return c.primaryTerm
    }
  }
  return 0
}
