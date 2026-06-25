import {
  type CommitMarkerState,
  encodeMarkerSlot,
  markerSlotOffset,
  nextMarkerSlot,
  readCommitMarker,
} from './commit-marker'
import type { DurableDirectory, MarkerHandle } from './durable-filesystem'

export interface MarkerWriter {
  commit(state: Omit<CommitMarkerState, 'writeSeq'>, fsync: boolean): Promise<void>
  close(): Promise<void>
  readonly created: boolean
  readonly existingHighestDurableSeqNo: number
}

function markerKey(indexName: string, partitionId: number): string {
  return `${indexName}/wal/${partitionId}/commit`
}

export async function createMarkerWriter(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
): Promise<MarkerWriter> {
  const key = markerKey(indexName, partitionId)
  const handle: MarkerHandle = await directory.markerHandle(key)
  const existing = await handle.read()
  const current = readCommitMarker(existing)
  const createdFresh = existing.length === 0

  let lastSlot = current?.slotIndex ?? null
  let writeSeq = current?.state.writeSeq ?? 0

  return {
    created: createdFresh,
    existingHighestDurableSeqNo: current?.state.highestDurableSeqNo ?? 0,

    async commit(state: Omit<CommitMarkerState, 'writeSeq'>, fsync: boolean): Promise<void> {
      const slotIndex = nextMarkerSlot(lastSlot)
      writeSeq += 1
      const slot = encodeMarkerSlot({ ...state, writeSeq })
      await handle.writeSlot(markerSlotOffset(slotIndex), slot, fsync)
      lastSlot = slotIndex
    },

    async close(): Promise<void> {
      await handle.close()
    },
  }
}
