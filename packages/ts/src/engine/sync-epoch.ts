import { loadStorageCode } from '../persistence/storage-code'
import type { EngineCore } from './core'

type EpochCore = Pick<EngineCore, 'durability' | 'indexRegistry' | 'requireIndex' | 'mutationCtx'>

export async function holdSyncEpochChange(core: EpochCore, indexName: string): Promise<() => void> {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined || (entry.sync === null && entry.changes === null)) return () => undefined
  return (await loadStorageCode()).holdRenewedSyncEpoch(core, indexName)
}

export async function withRenewedSyncEpoch<T>(
  core: EpochCore,
  indexName: string,
  change: () => Promise<T>,
): Promise<T> {
  const release = await holdSyncEpochChange(core, indexName)
  try {
    return await change()
  } finally {
    release()
  }
}
