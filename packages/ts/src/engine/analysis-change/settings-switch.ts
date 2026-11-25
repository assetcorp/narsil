import { ErrorCodes, emitSyncChange, NarsilError, textRebuildTargetOf } from '#platform/storage-host'
import { type ChangeScope, restoreInFlightError, stoppedError } from './build'
import { waitForRelease } from './run'
import { currentConfigUnderTarget, durableSettingsOf, namedSettingsOf } from './settings'

export async function switchQuerySettings(scope: ChangeScope): Promise<void> {
  const { core, indexName, entry, run, generation } = scope
  const manager = core.requireManager(indexName)
  const durable = core.durability?.manager
  const refusal: { byRestore: NarsilError | null } = { byRestore: null }
  const isCurrent = (): boolean =>
    run.stopReason === null &&
    refusal.byRestore === null &&
    !core.shutdownState.isShutdown &&
    core.indexRegistry.get(indexName) === entry &&
    core.executor.getManager(indexName) === manager
  if (durable !== undefined && (entry.pendingAnalysis?.generation !== generation || run.hold !== null)) {
    entry.pendingAnalysis = { generation, ...namedSettingsOf(run.target.config, run.target.language.name) }
    await durable.persistMetadata(indexName)
  }
  if (run.hold !== null && !(await waitForRelease(run, run.hold, isCurrent))) {
    throw run.stopReason ?? stoppedError(core, indexName)
  }
  const config = currentConfigUnderTarget(entry.config, run.target)
  const swap = async (): Promise<boolean> => {
    if (!isCurrent()) return false
    if (core.restoresInFlight.has(indexName)) {
      refusal.byRestore = restoreInFlightError(indexName)
      return false
    }
    await manager.publication.write(() => {
      run.switched = true
      entry.durableAnalysis = core.durability === null ? null : durableSettingsOf(entry, false)
      entry.config = config
      entry.analysisGeneration = generation
      entry.pendingAnalysis = null
      manager.adoptAnalysis({
        ...textRebuildTargetOf(config, entry.language, run.target.analysis),
        synonyms: manager.synonyms,
      })
      core.orchestrator.publishToWorkers({
        type: 'replaceFoldMarks',
        indexName,
        requestId: `replace-fold-marks-${indexName}`,
        ...(config.foldMarks !== undefined ? { foldMarks: config.foldMarks } : {}),
      })
    })
    return true
  }
  if (!(await swap())) throw run.stopReason ?? refusal.byRestore ?? stoppedError(core, indexName)
  await durable?.checkpointAfterInFlight(indexName)
  await core.orchestrator.awaitWrites(indexName)
  if (entry.durableAnalysis !== null) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The new settings of index "${indexName}" answer queries, but they have no durable checkpoint yet`,
      { indexName },
    )
  }
  if (entry.sync !== null) emitSyncChange(core.indexRegistry, { kind: 'settings', indexName })
}
