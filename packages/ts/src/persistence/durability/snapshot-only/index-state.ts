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
