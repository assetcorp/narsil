export interface SnapshotIndexState {
  mutationsSinceCheckpoint: number
  checkpointInFlight: Promise<void> | null
  applyChain: Promise<void>
  unloading: boolean
  appliedSeqNoByPartition: Map<number, number>
}

export function createSnapshotIndexState(): SnapshotIndexState {
  return {
    mutationsSinceCheckpoint: 0,
    checkpointInFlight: null,
    applyChain: Promise.resolve(),
    unloading: false,
    appliedSeqNoByPartition: new Map(),
  }
}

export function metadataKey(indexName: string): string {
  return `${indexName}/meta`
}

export function noteSnapshotCommitted(
  state: SnapshotIndexState,
  positions: ReadonlyMap<number, number>,
  partitionCount: number,
): void {
  let recordsLeft = 0
  for (const [partitionId, sequence] of state.appliedSeqNoByPartition) {
    if (partitionId >= partitionCount) {
      state.appliedSeqNoByPartition.delete(partitionId)
      continue
    }
    recordsLeft += Math.max(0, sequence - (positions.get(partitionId) ?? 0))
  }
  state.mutationsSinceCheckpoint = recordsLeft
}
