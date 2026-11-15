import { checkpointInTurn } from '../checkpoint-turn'
import type { SnapshotIndexState } from './index-state'

export interface ShutdownSaveDeps {
  indexes: ReadonlyMap<string, SnapshotIndexState>
  checkpoint(indexName: string, indexState: SnapshotIndexState): Promise<void>
  onFailure(error: Error): void
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function saveIndex(deps: ShutdownSaveDeps, indexName: string, indexState: SnapshotIndexState): Promise<void> {
  await indexState.applyChain
  await checkpointInTurn(indexState, {
    joinsInFlight: false,
    mayStart: () => !indexState.unloading && indexState.mutationsSinceCheckpoint > 0,
    perform: () => indexState.applyChain.then(() => deps.checkpoint(indexName, indexState)),
    afterSettling: () => undefined,
  })
}

export interface ShutdownReleaseDeps extends ShutdownSaveDeps {
  settleMetadataWrites(): Promise<void>
  release(): void
}

async function saveUnsavedIndexes(deps: ShutdownSaveDeps): Promise<void> {
  let failure: Error | null = null
  for (const [indexName, indexState] of deps.indexes) {
    try {
      await saveIndex(deps, indexName, indexState)
    } catch (error) {
      const failed = asError(error)
      deps.onFailure(failed)
      failure ??= failed
    }
  }
  if (failure !== null) throw failure
}

export async function saveAndReleaseIndexes(deps: ShutdownReleaseDeps): Promise<void> {
  try {
    await saveUnsavedIndexes(deps)
  } finally {
    await deps.settleMetadataWrites()
    deps.release()
  }
}
