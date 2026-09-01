import type { SeqOwner } from './seq-owner'
import type { WalWriter } from './wal-writer'

export interface PartitionState {
  walWriter: WalWriter
  seqOwner: SeqOwner
  appendChain: Promise<void>
  appliedSeqNo: number
  failed: Error | null
}

export interface IndexState {
  partitions: Map<number, PartitionState>
  mutationsSinceCheckpoint: number
  checkpointInFlight: Promise<void> | null
  unloading: boolean
}

/**
 * Drains an index's durable work so its memory can be released.
 *
 * The index stops accepting checkpoints, waits for the checkpoint and metadata
 * writes already in flight, and closes every partition's log writer. A failure
 * restores the index to its serving state and rethrows.
 *
 * @param indexState - The durable state of the index leaving memory.
 * @param pendingMetadataWrite - The newest queued metadata write, when one exists.
 * @param closeWalWriter - Awaits one log writer close, deciding how a failure reports.
 * @returns A promise that settles once every durable write has finished.
 */
export async function drainIndexStateForUnload(
  indexState: IndexState,
  pendingMetadataWrite: Promise<void> | undefined,
  closeWalWriter: (close: Promise<void>) => Promise<void>,
): Promise<void> {
  indexState.unloading = true
  try {
    if (indexState.checkpointInFlight !== null) await indexState.checkpointInFlight
    await pendingMetadataWrite
    for (const partition of indexState.partitions.values()) {
      await closeWalWriter(partition.walWriter.close())
    }
  } catch (error) {
    indexState.unloading = false
    throw error
  }
}
