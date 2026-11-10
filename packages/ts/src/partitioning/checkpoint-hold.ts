import { ErrorCodes, NarsilError } from '#platform/storage-host'

const heldCheckpointErrors = new WeakSet<object>()

export function rebalanceCheckpointHeld(): Error {
  const error = new NarsilError(
    ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
    'Queued writes from the previous partition layout must be replayed before a checkpoint',
  )
  heldCheckpointErrors.add(error)
  return error
}

export async function holdScheduledCheckpoint(checkpoint: Promise<void>, requested: boolean): Promise<void> {
  try {
    await checkpoint
  } catch (error) {
    if (requested || typeof error !== 'object' || error === null || !heldCheckpointErrors.has(error)) throw error
  }
}
