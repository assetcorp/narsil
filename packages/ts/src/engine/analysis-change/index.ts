import { ARRAY_POSITION_GAP } from '../../core/constants'
import { ErrorCodes, NarsilError } from '../../errors'
import { rebuildTextIndexes, textRebuildTargetOf } from '../../partitioning/text-rebuild'
import type { AnalysisChange } from '../../types/analysis-operations'
import type { NamedAnalysisSettings, PendingAnalysisMetadata } from '../../types/internal'
import type { EngineCore, IndexRegistryEntry } from '../core'
import { emitEngineEvent } from '../events'
import { requireAnalysisRebuildMemory } from '../snapshot/memory-budget'
import { prepareStoredSynonyms, rulesOfStoredSynonyms } from '../synonym-sets'
import { type AnalysisTarget, targetOfPending } from './pending-target'
import { type ChangeRun, createHold, createRun, runsOf, stopRun, waitForRelease } from './run'
import {
  currentConfigUnderTarget,
  durableSettingsOf,
  holdsSettings,
  namedSettingsOf,
  requireSynonymsUnderTarget,
  resolveAnalysisTarget,
} from './settings'

function termBytesOf(core: EngineCore, indexName: string): number {
  let bytes = 0
  for (const partition of core.requireManager(indexName).getAllPartitions()) {
    bytes += partition.estimateMemoryBytes()
    for (const state of partition.readStates()) bytes -= state.docStore.contentBytes()
  }
  return Math.max(0, bytes)
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

async function requireNoUndurableSwitch(core: EngineCore, indexName: string, entry: IndexRegistryEntry): Promise<void> {
  if (entry.durableAnalysis === null) return
  const durable = core.durability?.manager
  await (durable?.checkpointFromMemory?.(indexName) ?? durable?.checkpoint(indexName))
  if (entry.durableAnalysis === null) return
  throw new NarsilError(
    ErrorCodes.ANALYSIS_CHANGE_NOT_READY,
    `The previous analysis change of index "${indexName}" has no durable checkpoint yet, so try this change again once a checkpoint succeeds`,
    { indexName },
  )
}

interface ChangeScope {
  core: EngineCore
  indexName: string
  entry: IndexRegistryEntry
  run: ChangeRun
  generation: number
}

function switchIndex({ core, indexName, entry, run, generation }: ChangeScope) {
  const { language, analysis } = run.target
  const config = currentConfigUnderTarget(entry.config, run.target)
  const synonyms = prepareStoredSynonyms(rulesOfStoredSynonyms(entry.synonyms), config, language)
  return (): void => {
    run.switched = true
    entry.durableAnalysis = core.durability === null ? null : durableSettingsOf(entry)
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

async function buildAndSwitch(scope: ChangeScope): Promise<void> {
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
  let adopt: () => void = () => undefined
  const isCurrent = (): boolean =>
    run.stopReason === null &&
    !core.shutdownState.isShutdown &&
    core.indexRegistry.get(indexName) === entry &&
    core.executor.getManager(indexName) === manager
  emit('started', 0)
  const wasPromoted = core.orchestrator.desyncIndex(indexName)
  try {
    const durable = core.durability?.manager
    const rebuilt = await rebuildTextIndexes(
      manager,
      {
        isCurrent,
        onPartitionBuilt(built) {
          partitionsRebuilt = built
        },
        onSwitch: () => adopt(),
        ...(hold === null ? {} : { holdBeforeSwitch: keepCurrent => waitForRelease(run, hold, keepCurrent) }),
        runSwitch(swap) {
          const swapWithSynonyms = (): boolean => {
            if (!isCurrent()) return false
            adopt = switchIndex(scope)
            return swap()
          }
          return durable?.checkpointAfterSwitch?.(indexName, swapWithSynonyms) ?? Promise.resolve(swapWithSynonyms())
        },
      },
      textRebuildTargetOf(run.target.config, run.target.language, run.target.analysis),
    )
    if (!rebuilt) throw run.stopReason ?? stoppedError(core, indexName)
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

function stoppedError(core: EngineCore, indexName: string): NarsilError {
  if (core.shutdownState.isShutdown) {
    return new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'This Narsil instance has been shut down')
  }
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" closed during its analysis change`, {
    indexName,
  })
}

async function clearPending(core: EngineCore, indexName: string, entry: IndexRegistryEntry): Promise<void> {
  entry.pendingAnalysis = null
  await core.durability?.manager.persistMetadata(indexName)
}

function requireNotRebalancing(core: EngineCore, indexName: string): void {
  if (!core.rebalancingIndexes.has(indexName)) return
  throw new NarsilError(
    ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
    `Index "${indexName}" is being rebalanced, so try its analysis change again once the rebalance ends`,
    { indexName },
  )
}

async function driveRun(
  core: EngineCore,
  indexName: string,
  entry: IndexRegistryEntry,
  run: ChangeRun & { settle(): void },
  previous: ChangeRun | undefined,
  resumedGeneration: number | null,
): Promise<void> {
  const runs = runsOf(core)
  try {
    if (previous !== undefined) await previous.settled
    if (runs.get(indexName) !== run) return
    await requireNoUndurableSwitch(core, indexName, entry)
    if (run.stopReason !== null) return
    if (core.indexRegistry.get(indexName) !== entry) throw stoppedError(core, indexName)
    requireNotRebalancing(core, indexName)
    if (resumedGeneration === null && holdsSettings(entry.config, run.target)) {
      if (entry.pendingAnalysis !== null) await clearPending(core, indexName, entry)
      run.finish()
      return
    }
    const generation =
      resumedGeneration ?? Math.max(entry.analysisGeneration, entry.pendingAnalysis?.generation ?? 0) + 1
    if (entry.pendingAnalysis?.generation !== generation || run.hold !== null) {
      entry.pendingAnalysis = { generation, ...namedSettingsOf(run.target.config, run.target.language.name) }
      await core.durability?.manager.persistMetadata(indexName)
    }
    if (run.stopReason !== null) return
    await core.analysisRebuild.abandon(indexName)
    await core.analysisRebuild.runExclusive(
      indexName,
      () => buildAndSwitch({ core, indexName, entry, run, generation }),
      run.hold?.ready,
    )
    run.finish()
  } catch (error) {
    run.fail(error)
    const keepsPending = resumedGeneration !== null || core.shutdownState.isShutdown
    const stillOwnsPending = runs.get(indexName) === run && run.stopReason === null
    if (!keepsPending && stillOwnsPending && core.indexRegistry.get(indexName) === entry) {
      if (entry.pendingAnalysis !== null) await clearPending(core, indexName, entry).catch(() => undefined)
    }
  } finally {
    if (runs.get(indexName) === run) runs.delete(indexName)
    run.settle()
  }
}

export { adoptSavedAnalysis } from './adopt-saved'

export async function changeIndexAnalysis(core: EngineCore, indexName: string, change: AnalysisChange): Promise<void> {
  const entry = core.requireIndex(indexName)
  requireNotRebalancing(core, indexName)
  const target = resolveAnalysisTarget(indexName, entry.config, change)
  const runs = runsOf(core)
  const previous = runs.get(indexName)
  if (previous !== undefined && holdsSettings(previous.target.config, target)) return previous.finished
  const heldAlready = holdsSettings(entry.config, target)
  if (previous === undefined && entry.durableAnalysis === null && heldAlready) return
  if (!heldAlready) {
    requireSynonymsUnderTarget(entry, target)
    requireAnalysisRebuildMemory(indexName, termBytesOf(core, indexName))
  }
  const run = createRun(target)
  if (previous !== undefined && !previous.switched) stopRun(previous, indexName)
  runs.set(indexName, run)
  void driveRun(core, indexName, entry, run, previous, null)
  return run.finished
}

export function resumeAnalysisChange(core: EngineCore, indexName: string): Promise<void> {
  const entry = core.requireIndex(indexName)
  const runs = runsOf(core)
  const running = runs.get(indexName)
  if (running !== undefined) return running.finished
  const pending = entry.pendingAnalysis
  if (pending === null) return Promise.resolve()
  let target: AnalysisTarget
  try {
    target = targetOfPending(entry, pending)
    requireAnalysisRebuildMemory(indexName, termBytesOf(core, indexName))
  } catch (error) {
    emitEngineEvent(core.eventHandlers, 'analysisRebuild', {
      indexName,
      status: 'failed',
      partitionsRebuilt: 0,
      partitionCount: entry.partitionCount,
      error: toError(error),
    })
    return Promise.reject(error)
  }
  const run = createRun(target)
  runs.set(indexName, run)
  void driveRun(core, indexName, entry, run, undefined, pending.generation)
  return run.finished
}

export async function abandonAnalysisChange(core: EngineCore, indexName: string): Promise<void> {
  const run = runsOf(core).get(indexName)
  if (run === undefined) return
  stopRun(run, indexName)
  await run.settled
}

function holdServes(run: ChangeRun, entry: IndexRegistryEntry, pending: PendingAnalysisMetadata): boolean {
  return (
    run.hold?.generation === pending.generation && holdsSettings(run.target.config, targetOfPending(entry, pending))
  )
}

function startHeldRun(core: EngineCore, indexName: string, pending: PendingAnalysisMetadata): ChangeRun | null {
  const entry = core.requireIndex(indexName)
  if (entry.analysisGeneration >= pending.generation) return null
  const runs = runsOf(core)
  const previous = runs.get(indexName)
  if (previous !== undefined && holdServes(previous, entry, pending)) return previous
  const target = targetOfPending(entry, pending)
  requireSynonymsUnderTarget(entry, target)
  requireAnalysisRebuildMemory(indexName, termBytesOf(core, indexName))
  const run = createRun(target, createHold(pending.generation))
  if (previous !== undefined && !previous.switched) stopRun(previous, indexName)
  runs.set(indexName, run)
  void driveRun(core, indexName, entry, run, previous, pending.generation)
  return run
}

export async function buildHeldAnalysisChange(
  core: EngineCore,
  indexName: string,
  pending: PendingAnalysisMetadata,
): Promise<void> {
  const running = runsOf(core).get(indexName)
  const entry = core.indexRegistry.get(indexName)
  if (running?.hold != null && entry !== undefined && holdServes(running, entry, pending)) return running.hold.ready
  const release = await core.indexState.acquire(indexName, false)
  let run: ChangeRun | null
  try {
    run = startHeldRun(core, indexName, pending)
  } catch (error) {
    release()
    throw error
  }
  if (run?.hold === undefined || run.hold === null) {
    release()
    return
  }
  void run.settled.finally(release)
  return run.hold.ready
}

export function heldAnalysisIsBuilt(core: EngineCore, indexName: string, generation: number): boolean {
  const hold = runsOf(core).get(indexName)?.hold
  return hold !== undefined && hold !== null && hold.generation === generation && hold.built
}

export async function releaseHeldAnalysisChange(
  core: EngineCore,
  indexName: string,
  generation: number,
): Promise<void> {
  const run = runsOf(core).get(indexName)
  if (run?.hold?.generation !== generation) return
  run.hold.released = true
  run.hold.wake()
  await run.finished
}

export async function dropHeldAnalysisChange(core: EngineCore, indexName: string): Promise<void> {
  await abandonAnalysisChange(core, indexName)
  const entry = core.indexRegistry.get(indexName)
  if (entry !== undefined && entry.pendingAnalysis !== null) await clearPending(core, indexName, entry)
}

export function holdsNamedSettings(entry: IndexRegistryEntry, settings: NamedAnalysisSettings): boolean {
  return holdsSettings(entry.config, targetOfPending(entry, { generation: 0, ...settings }))
}

export async function stampAnalysisGeneration(core: EngineCore, indexName: string, generation: number): Promise<void> {
  const entry = core.requireIndex(indexName)
  if (entry.analysisGeneration >= generation) return
  await requireNoUndurableSwitch(core, indexName, entry)
  const durable = core.durability?.manager
  const stamp = (): boolean => {
    entry.durableAnalysis = core.durability === null ? null : durableSettingsOf(entry)
    entry.analysisGeneration = generation
    entry.pendingAnalysis = null
    return true
  }
  await (durable?.checkpointAfterSwitch?.(indexName, stamp) ?? Promise.resolve(stamp()))
}
