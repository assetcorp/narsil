import { generateId } from '../../../core/id-generator'
import {
  type AnalysisTarget,
  holdsSettings,
  namedSettingsOf,
  resolveAnalysisTarget,
} from '../../../engine/analysis-change/settings'
import { prepareConfiguredSynonyms } from '../../../engine/synonym-sets'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnalysisChange } from '../../../types/analysis-operations'
import { metadataWithoutPendingAnalysis, metadataWithPendingAnalysis } from '../../cluster/analysis-metadata'
import { ANALYSIS_CHANGE_POLL_INTERVAL_MS } from '../../cluster/constants'
import {
  type IndexMetadataSnapshot,
  indexConfigKey,
  readIndexMetadataSnapshot,
  readIndexState,
  validateIndexName,
} from '../../cluster/index-metadata'
import { indexConfigFromSettings, type PendingClusterAnalysis } from '../../cluster/index-settings'
import { pause } from '../../cluster/rebalance/pause'
import { readRebalanceRecord } from '../../cluster/rebalance/records'
import type { ClusterCoordinator } from '../../coordinator/types'
import { registeredNodesBelowBm25Tuning } from '../../query/bm25-routing'
import { MAX_SETTINGS_REPLACEMENT_ATTEMPTS } from '../constants'
import type { AnalysisView } from './view'

const SETTINGS_CONTENTION_REASON = 'settings_contention'

export interface AnalysisChangeRequest {
  coordinator: ClusterCoordinator
  view: AnalysisView
  guard: () => void
  servingName: string
  publicName: string
  change: AnalysisChange
}

function indexNotFound(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
    indexName,
  })
}

function sameList(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((word, position) => word === right[position])
}

function asksForPending(pending: PendingClusterAnalysis | undefined, target: AnalysisTarget): boolean {
  if (pending === undefined) return false
  const named = namedSettingsOf(target.config, target.language.name)
  return (
    pending.language === named.language &&
    pending.tokenizer === named.tokenizer &&
    pending.stopWords === named.stopWords &&
    sameList(pending.stopWordList, named.stopWordList)
  )
}

async function requireTargetAcceptable(
  coordinator: ClusterCoordinator,
  indexName: string,
  target: AnalysisTarget,
): Promise<void> {
  const state = await readIndexState(coordinator, indexName)
  if (state === null || state.synonyms.length === 0) return
  prepareConfiguredSynonyms({ ...target.config, synonyms: state.synonyms }, target.language)
}

async function writePending(
  coordinator: ClusterCoordinator,
  indexName: string,
  target: AnalysisTarget,
): Promise<PendingClusterAnalysis | null> {
  const schema = await coordinator.getSchema(indexName)
  if (schema === null) throw indexNotFound(indexName)
  for (let attempt = 1; attempt <= MAX_SETTINGS_REPLACEMENT_ATTEMPTS; attempt++) {
    const snapshot = await readIndexMetadataSnapshot(coordinator, indexName)
    if (snapshot === null) throw indexNotFound(indexName)
    const running = snapshot.settings?.pendingAnalysis
    if (running !== undefined && asksForPending(running, target)) return running
    const current = indexConfigFromSettings(schema, snapshot.settings, indexName)
    if (running === undefined && holdsSettings(current, target)) return null
    const pending: PendingClusterAnalysis = {
      changeId: generateId(),
      generation: Math.max(snapshot.settings?.analysisGeneration ?? 0, running?.generation ?? 0) + 1,
      ...namedSettingsOf(target.config, target.language.name),
    }
    const next = metadataWithPendingAnalysis(snapshot, pending)
    if (await coordinator.compareAndSet(indexConfigKey(indexName), snapshot.bytes, next)) return pending
  }
  throw new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `Index '${indexName}' kept changing while its analysis change was recorded ${MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so the change was not stored. Retry the request`,
    { reason: SETTINGS_CONTENTION_REASON, indexName, attempts: MAX_SETTINGS_REPLACEMENT_ATTEMPTS },
  )
}

async function clearOwnPending(coordinator: ClusterCoordinator, indexName: string, changeId: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SETTINGS_REPLACEMENT_ATTEMPTS; attempt++) {
    const snapshot = await readIndexMetadataSnapshot(coordinator, indexName)
    if (snapshot?.settings?.pendingAnalysis?.changeId !== changeId) return
    const next = metadataWithoutPendingAnalysis(snapshot)
    if (await coordinator.compareAndSet(indexConfigKey(indexName), snapshot.bytes, next)) return
  }
}

function outcomeOf(
  snapshot: IndexMetadataSnapshot,
  pending: PendingClusterAnalysis,
  indexName: string,
): 'waiting' | 'published' {
  const settings = snapshot.settings
  if (settings?.analysisGeneration === pending.generation) return 'published'
  const failure = settings?.analysisFailure
  if (failure?.changeId === pending.changeId) {
    throw new NarsilError(failure.code, failure.message, { indexName, nodeId: failure.nodeId })
  }
  if (settings?.pendingAnalysis?.changeId === pending.changeId) return 'waiting'
  throw new NarsilError(
    ErrorCodes.ANALYSIS_CHANGE_REPLACED,
    `A later change replaced this analysis change of index '${indexName}'`,
    { indexName },
  )
}

export async function changeClusterAnalysis(request: AnalysisChangeRequest): Promise<void> {
  const { coordinator, view, guard, servingName, publicName, change } = request
  validateIndexName(servingName)
  const schema = await coordinator.getSchema(servingName)
  const first = await readIndexMetadataSnapshot(coordinator, servingName)
  if (schema === null || first === null) throw indexNotFound(publicName)
  const target = resolveAnalysisTarget(publicName, indexConfigFromSettings(schema, first.settings, servingName), change)
  await requireTargetAcceptable(coordinator, servingName, target)
  const olderNodes = registeredNodesBelowBm25Tuning(await coordinator.listNodes())
  if (olderNodes.length > 0) {
    throw new NarsilError(
      ErrorCodes.ANALYSIS_CHANGE_NOT_READY,
      `The cluster has nodes below the specification version that changes analysis, so index '${publicName}' keeps its settings until they are upgraded`,
      { indexName: publicName, nodeIds: olderNodes },
    )
  }
  const pending = await writePending(coordinator, servingName, target)
  if (pending === null) return
  if ((await readRebalanceRecord(coordinator, publicName)) !== null) {
    await clearOwnPending(coordinator, servingName, pending.changeId)
    throw new NarsilError(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      `Index '${publicName}' is changing its partition count, so try its analysis change again once that ends`,
      { indexName: publicName },
    )
  }
  for (;;) {
    guard()
    const snapshot = await readIndexMetadataSnapshot(coordinator, servingName)
    if (snapshot === null) throw indexNotFound(publicName)
    if (outcomeOf(snapshot, pending, publicName) === 'published') break
    await pause(ANALYSIS_CHANGE_POLL_INTERVAL_MS)
  }
  await view.refresh(servingName)
  await view.settle(servingName)
}
