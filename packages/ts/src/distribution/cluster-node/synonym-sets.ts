import { decode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { configOfNamedSettings } from '../../engine/analysis-change/pending-target'
import { prepareConfiguredSynonyms } from '../../engine/synonym-sets'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import type { SynonymRule } from '../../types/synonyms'
import {
  type IndexMetadataSnapshot,
  indexConfigKey,
  metadataWithSynonymSet,
  readIndexMetadataSnapshot,
  readIndexState,
  validateIndexName,
} from '../cluster/index-metadata'
import { indexConfigFromSettings } from '../cluster/index-settings'
import { createIndexSettingsMessage, validateIndexSettingsResultPayload } from '../cluster/index-settings-message'
import { readRebalanceRecord } from '../cluster/rebalance/records'
import { deleteSynonymSet, type SynonymSetRef, storeSynonymSet } from '../cluster/synonym-set'
import type { ClusterCoordinator } from '../coordinator/types'
import { isRecord } from '../payload-guards'
import { TransportError } from '../transport/types'
import { MAX_SETTINGS_REPLACEMENT_ATTEMPTS, SETTINGS_CONTENTION_REASON } from './constants'
import { servingNameOf } from './generation-routing'
import type { ClusterLocalEngine } from './local-engine'
import { resolveNodeTargets } from './node-messaging'
import type { ClusterNodeConfig } from './types'

export interface ClusterSynonymDeps {
  config: ClusterNodeConfig
  nodeId: string
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
}

function indexNotFound(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
    indexName,
  })
}

export async function readClusterSynonyms(coordinator: ClusterCoordinator, indexName: string): Promise<SynonymRule[]> {
  validateIndexName(indexName)
  const state = await readIndexState(coordinator, await servingNameOf(coordinator, indexName))
  if (state === null) throw indexNotFound(indexName)
  return state.synonyms
}

async function requireSettledPartitionCount(
  coordinator: ClusterCoordinator,
  indexName: string,
  servingName: string,
): Promise<void> {
  const settled =
    (await readRebalanceRecord(coordinator, indexName)) === null &&
    (await servingNameOf(coordinator, indexName)) === servingName
  if (settled) return
  throw new NarsilError(
    ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
    `Index '${indexName}' is changing its partition count, so replace its synonym set again once that ends`,
    { indexName },
  )
}

export function applyStoredSynonyms(
  engine: ClusterLocalEngine,
  coordinator: ClusterCoordinator,
  indexName: string,
  indexUuid: string,
): Promise<boolean> {
  if (engine.indexUuidOf(indexName) !== indexUuid) return Promise.resolve(false)
  return engine.applyStoredSynonyms(indexName, async () => {
    if (engine.indexUuidOf(indexName) !== indexUuid) return null
    const state = await readIndexState(coordinator, indexName)
    if (state === null || state.record.indexUuid !== indexUuid) return null
    return state.synonyms
  })
}

function preparedSet(snapshot: IndexMetadataSnapshot, indexName: string, synonyms: SynonymRule[]): Uint8Array | null {
  const config = indexConfigFromSettings({}, snapshot.settings, indexName)
  const language = getLanguage(config.language ?? 'english')
  const pending = snapshot.settings?.pendingAnalysis
  if (pending !== undefined) {
    prepareConfiguredSynonyms({ ...configOfNamedSettings(config, pending), synonyms }, getLanguage(pending.language))
  }
  return prepareConfiguredSynonyms({ ...config, synonyms }, language)?.encoded ?? null
}

async function swapStoredSet(
  coordinator: ClusterCoordinator,
  indexName: string,
  first: IndexMetadataSnapshot,
  ref: SynonymSetRef | null,
): Promise<SynonymSetRef | null> {
  const { indexUuid } = first.record
  let current: IndexMetadataSnapshot | null = first
  for (let attempt = 1; ; attempt++) {
    if (current === null || current.record.indexUuid !== indexUuid) throw indexNotFound(indexName)
    const replaced = current.settings?.synonyms ?? null
    const next = metadataWithSynonymSet(current, ref)
    if (await coordinator.compareAndSet(indexConfigKey(indexName), current.bytes, next)) return replaced
    if (attempt >= MAX_SETTINGS_REPLACEMENT_ATTEMPTS) {
      throw new NarsilError(
        ErrorCodes.CLUSTER_WRITE_BLOCKED,
        `Index '${indexName}' kept changing while its synonym set was replaced ${attempt} times over, so the new set was not stored. Retry the request`,
        { reason: SETTINGS_CONTENTION_REASON, indexName, attempts: attempt },
      )
    }
    current = await readIndexMetadataSnapshot(coordinator, indexName)
  }
}

async function askNodeToApply(deps: ClusterSynonymDeps, nodeId: string, indexName: string, indexUuid: string) {
  if (nodeId === deps.nodeId) {
    await applyStoredSynonyms(deps.engine, deps.coordinator, indexName, indexUuid)
    return
  }
  const message = createIndexSettingsMessage({ indexName, indexUuid }, deps.nodeId, generateId())
  const failure = { indexName, targetNodeId: nodeId }
  let lastError: unknown
  for (const target of await resolveNodeTargets(deps.config, nodeId)) {
    let response: Awaited<ReturnType<typeof deps.config.transport.send>>
    try {
      response = await deps.config.transport.send(target, message)
    } catch (error) {
      lastError = error
      continue
    }
    const decoded: unknown = decode(response.payload)
    const answer = validateIndexSettingsResultPayload(decoded)
    if (!response.type.endsWith('.error') && answer !== null) return
    const reply = isRecord(decoded) ? decoded : {}
    throw new NarsilError(
      typeof reply.code === 'string' ? reply.code : ErrorCodes.QUERY_ROUTING_FAILED,
      typeof reply.message === 'string'
        ? reply.message
        : `Node '${nodeId}' did not apply the synonym set of index '${indexName}'`,
      failure,
    )
  }
  throw new NarsilError(
    ErrorCodes.QUERY_NODE_TIMEOUT,
    `Node '${nodeId}' did not answer when asked to apply the new synonym set of index '${indexName}'. The set stays stored, so retry the request to finish applying it`,
    { ...failure, ...(lastError instanceof TransportError ? { transportCode: lastError.code } : {}) },
  )
}

export async function replaceClusterSynonyms(
  deps: ClusterSynonymDeps,
  indexName: string,
  synonyms: SynonymRule[],
): Promise<void> {
  const { coordinator } = deps
  validateIndexName(indexName)
  const servingName = await servingNameOf(coordinator, indexName)
  await requireSettledPartitionCount(coordinator, indexName, servingName)
  const first = await readIndexMetadataSnapshot(coordinator, servingName)
  if (first === null) throw indexNotFound(indexName)
  const encoded = preparedSet(first, servingName, synonyms)
  const { indexUuid } = first.record
  const ref = encoded === null ? null : await storeSynonymSet(coordinator, indexUuid, encoded)
  let replaced: SynonymSetRef | null
  try {
    replaced = await swapStoredSet(coordinator, servingName, first, ref)
  } catch (err) {
    if (ref !== null) await deleteSynonymSet(coordinator, indexUuid, ref).catch(() => undefined)
    throw err
  }
  if (replaced !== null && replaced.generation !== ref?.generation) {
    await deleteSynonymSet(coordinator, indexUuid, replaced)
  }
  const allocation = await coordinator.getAllocation(servingName)
  const holders = new Set<string>()
  for (const assignment of allocation?.assignments.values() ?? []) {
    for (const nodeId of assignment.replicas) holders.add(nodeId)
    if (assignment.primary !== null) holders.add(assignment.primary)
  }
  await Promise.all([...holders].map(nodeId => askNodeToApply(deps, nodeId, servingName, indexUuid)))
  await requireSettledPartitionCount(coordinator, indexName, servingName)
}
