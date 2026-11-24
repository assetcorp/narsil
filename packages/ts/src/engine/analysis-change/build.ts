import {
  ARRAY_POSITION_GAP,
  ErrorCodes,
  emitEngineEvent,
  holdSyncEpochChange,
  NarsilError,
  prepareStoredSynonyms,
  rebuildTextIndexes,
  rulesOfStoredSynonyms,
  textRebuildTargetOf,
} from '#platform/storage-host'
import type { RewriteSpill } from '../../persistence/paged/rewrite-spill'
import type { EngineCore, IndexRegistryEntry } from '../core'
import { type ChangeRun, waitForRelease } from './run'
import { currentConfigUnderTarget, durableSettingsOf } from './settings'

export function termBytesOf(core: EngineCore, indexName: string): number {
  let bytes = 0
  for (const partition of core.requireManager(indexName).getAllPartitions()) {
    bytes += partition.estimateMemoryBytes()
    for (const state of partition.readStates()) bytes -= state.docStore.contentBytes()
  }
  return Math.max(0, bytes)
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export interface ChangeScope {
  core: EngineCore
  indexName: string
  entry: IndexRegistryEntry
  run: ChangeRun
  generation: number
}

export function stoppedError(core: EngineCore, indexName: string): NarsilError {
  if (core.shutdownState.isShutdown) {
    return new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'This Narsil instance has been shut down')
  }
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" closed during its analysis change`, {
    indexName,
  })
}

export function restoreInFlightError(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.ANALYSIS_CHANGE_REPLACED,
    `A restore of index "${indexName}" is in flight and replaces this analysis change, so try the change again once the restore ends`,
    { indexName },
  )
}

function switchIndex({ core, indexName, entry, run, generation }: ChangeScope) {
  const { language, analysis } = run.target
  const config = currentConfigUnderTarget(entry.config, run.target)
  const synonyms = prepareStoredSynonyms(rulesOfStoredSynonyms(entry.synonyms), config, language)
  return (): void => {
    run.switched = true
    entry.durableAnalysis = core.durability === null ? null : durableSettingsOf(entry, true)
    entry.config = config
    entry.language = language
    entry.analysisGeneration = generation
    entry.analysisRevision = language.revision
    entry.arrayPositionGap = ARRAY_POSITION_GAP
    entry.pendingAnalysis = null
    entry.synonyms = synonyms?.encoded ?? null
    core.requireManager(indexName).adoptAnalysis({
      ...textRebuildTargetOf(config, language, analysis),
      synonyms: synonyms?.lookup ?? null,
    })
    core.analysisRebuild.clearStale(indexName)
  }
}

export async function buildAndSwitch(scope: ChangeScope): Promise<void> {
  const { core, indexName, entry, run } = scope
  const { hold } = run
  const manager = core.requireManager(indexName)
  const emit = (status: 'started' | 'completed' | 'failed', partitionsRebuilt: number, error?: Error): void => {
    emitEngineEvent(core.eventHandlers, 'analysisRebuild', {
      indexName,
      status,
      partitionsRebuilt,
      partitionCount: manager.partitionCount,
      ...(error !== undefined ? { error } : {}),
    })
  }
  let partitionsRebuilt = 0
  const refusal: { byRestore: NarsilError | null } = { byRestore: null }
  const isCurrent = (): boolean =>
    run.stopReason === null &&
    refusal.byRestore === null &&
    !core.shutdownState.isShutdown &&
    core.indexRegistry.get(indexName) === entry &&
    core.executor.getManager(indexName) === manager
  emit('started', 0)
  const wasPromoted = core.orchestrator.desyncIndex(indexName)
  try {
    const durable = core.durability?.manager
    let spill: RewriteSpill | null = null
    const rebuilt = await rebuildTextIndexes(
      manager,
      {
        isCurrent,
        rewriteStorage: () => durable?.rewriteStorage?.(),
        onRewriteSpill(kept) {
          spill = kept
        },
        onPartitionBuilt(built) {
          partitionsRebuilt = built
        },
        onSwitch: () => switchIndex(scope)(),
        ...(hold === null ? {} : { holdBeforeSwitch: keepCurrent => waitForRelease(run, hold, keepCurrent) }),
        async runSwitch(swap) {
          const swapWithSynonyms = (): boolean | Promise<boolean> => {
            if (!isCurrent()) return false
            if (core.restoresInFlight.has(indexName)) {
              refusal.byRestore = restoreInFlightError(indexName)
              return false
            }
            return swap()
          }
          const releaseSyncEpoch = await holdSyncEpochChange(core, indexName)
          try {
            return await (durable?.checkpointAfterSwitch?.(indexName, swapWithSynonyms) ?? swapWithSynonyms())
          } finally {
            releaseSyncEpoch()
          }
        },
      },
      textRebuildTargetOf(run.target.config, run.target.language, run.target.analysis),
    )
    if (!rebuilt) throw run.stopReason ?? refusal.byRestore ?? stoppedError(core, indexName)
    await (spill as RewriteSpill | null)?.removeUnread(manager)
    if (entry.durableAnalysis !== null) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `The new terms of index "${indexName}" answer queries, but they have no durable checkpoint yet`,
        { indexName },
      )
    }
    emit('completed', partitionsRebuilt)
  } catch (error) {
    emit('failed', partitionsRebuilt, toError(error))
    throw error
  } finally {
    if (core.executor.getManager(indexName) === manager) {
      await core.orchestrator.resyncIndex(indexName, wasPromoted).catch(() => undefined)
    }
  }
}
