import { WRITES_STALL_ABOVE_UNCHECKPOINTED_BYTES } from './constants'
import type { IndexState } from './manager-state'

export function checkpointIsDue(
  indexState: IndexState,
  mutationThreshold: number,
  stallAboveBytes: number = WRITES_STALL_ABOVE_UNCHECKPOINTED_BYTES,
): boolean {
  return (
    indexState.mutationsSinceCheckpoint >= mutationThreshold ||
    indexState.documentBytesSinceCheckpoint >= stallAboveBytes
  )
}

export async function stallWhileCheckpointsFallBehind(
  indexState: IndexState,
  stallAboveBytes: number = WRITES_STALL_ABOVE_UNCHECKPOINTED_BYTES,
): Promise<void> {
  while (
    indexState.documentBytesSinceCheckpoint >= stallAboveBytes &&
    indexState.checkpointInFlight !== null &&
    !indexState.unloading
  ) {
    await new Promise<void>(resume => {
      indexState.stalledWrites.push(resume)
    })
  }
}

export function noteCheckpointCommitted(indexState: IndexState, recordsBeyondTheCheckpoint: number): void {
  const counted = indexState.mutationsSinceCheckpoint
  const shareLeft = counted <= 0 ? 0 : Math.min(1, recordsBeyondTheCheckpoint / counted)
  indexState.documentBytesSinceCheckpoint = Math.round(indexState.documentBytesSinceCheckpoint * shareLeft)
  indexState.mutationsSinceCheckpoint = recordsBeyondTheCheckpoint
  releaseStalledWrites(indexState)
}

export function releaseStalledWrites(indexState: IndexState): void {
  const waiting = indexState.stalledWrites.splice(0)
  for (const resume of waiting) resume()
}
