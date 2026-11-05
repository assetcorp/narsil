import type { EngineCore } from './core'

type EpochCore = Pick<EngineCore, 'durability' | 'indexRegistry' | 'requireIndex' | 'mutationCtx'>

export async function holdSyncEpochChange(core: EpochCore, indexName: string): Promise<() => void> {
  if ((core.indexRegistry.get(indexName)?.sync ?? null) === null) return () => undefined
  return (await import('./sync/operations')).holdRenewedSyncEpoch(core, indexName)
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
