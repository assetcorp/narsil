import { ErrorCodes, NarsilError } from '#platform/storage-host'

export class RebalanceCheckpointHeld extends NarsilError {
  constructor() {
    super(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      'Queued writes from the previous partition layout must be replayed before a checkpoint',
    )
  }
}

export async function holdScheduledCheckpoint(checkpoint: Promise<void>, requested: boolean): Promise<void> {
  try {
    await checkpoint
  } catch (error) {
    if (requested || !(error instanceof RebalanceCheckpointHeld)) throw error
  }
}
