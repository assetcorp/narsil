import {
  ErrorCodes,
  emitSyncChange,
  oneAtATime,
  storedBM25Params,
  validateBM25Params,
  withOpenIndex,
} from '#platform/optional-writes-host'
import type { BM25Params } from '../types/schema'
import type { EngineCore } from './core'

async function replaceNow(core: EngineCore, indexName: string, bm25: BM25Params | undefined): Promise<void> {
  const { config } = core.requireIndex(indexName)
  const manager = core.requireManager(indexName)
  const previous = config.bm25
  await manager.publication.write(() => {
    config.bm25 = bm25
    core.orchestrator.publishToWorkers({
      type: 'replaceBm25',
      indexName,
      requestId: `replace-bm25-${indexName}`,
      bm25,
    })
  })
  try {
    if (core.durability) await core.durability.manager.persistMetadata(indexName)
  } catch (err) {
    await manager.publication.write(() => {
      config.bm25 = previous
      core.orchestrator.publishToWorkers({
        type: 'replaceBm25',
        indexName,
        requestId: `restore-bm25-${indexName}`,
        bm25: previous,
      })
    })
    throw err
  }
  await core.orchestrator.awaitWrites(indexName)
  if (core.requireIndex(indexName).sync !== null) emitSyncChange(core.indexRegistry, { kind: 'settings', indexName })
}

export function updateIndexBm25(core: EngineCore, indexName: string, value: BM25Params): Promise<void> {
  return withOpenIndex(core, indexName, () =>
    oneAtATime(core, indexName, () => {
      const entry = core.requireIndex(indexName)
      validateBM25Params(value, entry.config.schema, ErrorCodes.CONFIG_INVALID)
      return replaceNow(core, indexName, storedBM25Params(value))
    }),
  )
}

export function applyStoredIndexBm25(
  core: EngineCore,
  indexName: string,
  load: () => { bm25: BM25Params | undefined } | null,
): Promise<boolean> {
  return withOpenIndex(core, indexName, () =>
    oneAtATime(core, indexName, async () => {
      const loaded = load()
      if (loaded === null) return false
      await replaceNow(core, indexName, loaded.bm25)
      return true
    }),
  )
}
