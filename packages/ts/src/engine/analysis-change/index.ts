import { ErrorCodes, NarsilError } from '../../errors'
import { rebuildTextIndexes, textRebuildTargetOf } from '../../partitioning/text-rebuild'
import type { AnalysisChange } from '../../types/analysis-operations'
import type { EngineCore, IndexRegistryEntry } from '../core'
import { emitEngineEvent } from '../events'
import { requireAnalysisRebuildMemory } from '../snapshot/memory-budget'
import { prepareStoredSynonyms, rulesOfStoredSynonyms } from '../synonym-sets'
import {
  type AnalysisTarget,
  durableSettingsOf,
  holdsSettings,
  namedSettingsOf,
  requireSynonymsUnderTarget,
  resolveAnalysisTarget,
  targetOfPending,
} from './settings'

interface ChangeRun {
  target: AnalysisTarget
  stopped: NarsilError | null
  switched: boolean
  settled: Promise<void>
  finish(): void
  fail(error: unknown): void
  finished: Promise<void>
}

const runsByCore = new WeakMap<EngineCore, Map<string, ChangeRun>>()

function runsOf(core: EngineCore): Map<string, ChangeRun> {
  let runs = runsByCore.get(core)
  if (runs === undefined) {
    runs = new Map()
    runsByCore.set(core, runs)
  }
  return runs
}

function createRun(target: AnalysisTarget): ChangeRun & { settle(): void } {
  let finish: () => void = () => undefined
  let fail: (error: unknown) => void = () => undefined
  let settle: () => void = () => undefined
  const finished = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  finished.catch(() => undefined)
  const settled = new Promise<void>(resolve => {
    settle = resolve
  })
  return { target, stopped: null, switched: false, settled, finish, fail, finished, settle }
}

function replacedError(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.ANALYSIS_CHANGE_REPLACED,
    `A later change or a restore replaced this analysis change of index "${indexName}"`,
    { indexName },
  )
}

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

function switchIndex(
  core: EngineCore,
  indexName: string,
  entry: IndexRegistryEntry,
  run: ChangeRun,
  generation: number,
) {
  const { config, language, analysis } = run.target
  const synonyms = prepareStoredSynonyms(rulesOfStoredSynonyms(entry.synonyms), config, language)
  return (): void => {
    run.switched = true
    entry.durableAnalysis = core.durability === null ? null : durableSettingsOf(entry)
    entry.config = config
    entry.language = language
    entry.analysisGeneration = generation
    entry.analysisRevision = language.revision
    entry.pendingAnalysis = null
    entry.synonyms = synonyms?.encoded ?? null
    core.requireManager(indexName).adoptAnalysis({
      ...textRebuildTargetOf(config, language, analysis),
      synonyms: synonyms?.lookup ?? null,
    })
    core.analysisRebuild.clearStale(indexName)
  }
}

async function buildAndSwitch(
  core: EngineCore,
  indexName: string,
  entry: IndexRegistryEntry,
  run: ChangeRun,
  generation: number,
): Promise<void> {
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
    run.stopped === null &&
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
        runSwitch(swap) {
          const swapWithSynonyms = (): boolean => {
            if (!isCurrent()) return false
            adopt = switchIndex(core, indexName, entry, run, generation)
            return swap()
          }
          return durable?.checkpointAfterSwitch?.(indexName, swapWithSynonyms) ?? Promise.resolve(swapWithSynonyms())
        },
      },
      textRebuildTargetOf(run.target.config, run.target.language, run.target.analysis),
    )
    if (!rebuilt) throw run.stopped ?? stoppedError(core, indexName)
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
    if (run.stopped !== null) return
    if (core.indexRegistry.get(indexName) !== entry) throw stoppedError(core, indexName)
    requireNotRebalancing(core, indexName)
    if (resumedGeneration === null && holdsSettings(entry.config, run.target)) {
      if (entry.pendingAnalysis !== null) await clearPending(core, indexName, entry)
      run.finish()
      return
    }
    const generation =
      resumedGeneration ?? Math.max(entry.analysisGeneration, entry.pendingAnalysis?.generation ?? 0) + 1
    if (resumedGeneration === null) {
      entry.pendingAnalysis = { generation, ...namedSettingsOf(run.target.config, run.target.language.name) }
      await core.durability?.manager.persistMetadata(indexName)
    }
    if (run.stopped !== null) return
    await core.analysisRebuild.abandon(indexName)
    await core.analysisRebuild.runExclusive(indexName, () => buildAndSwitch(core, indexName, entry, run, generation))
    run.finish()
  } catch (error) {
    run.fail(error)
    const keepsPending = resumedGeneration !== null || core.shutdownState.isShutdown
    const stillOwnsPending = runs.get(indexName) === run && run.stopped === null
    if (!keepsPending && stillOwnsPending && core.indexRegistry.get(indexName) === entry) {
      if (entry.pendingAnalysis !== null) await clearPending(core, indexName, entry).catch(() => undefined)
    }
  } finally {
    if (runs.get(indexName) === run) runs.delete(indexName)
    run.settle()
  }
}

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
  if (previous !== undefined && !previous.switched) {
    previous.stopped = replacedError(indexName)
    previous.fail(previous.stopped)
  }
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
  run.stopped = replacedError(indexName)
  run.fail(run.stopped)
  await run.settled
}
