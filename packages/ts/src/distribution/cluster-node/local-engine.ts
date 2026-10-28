import { resolveIndexAnalysis } from '../../analysis/registry'
import { requireKnownConfig } from '../../engine/config-keys'
import { createEngineCore, type EngineCore } from '../../engine/core'
import { createEngineIndex } from '../../engine/index-lifecycle'
import { startEngineCore } from '../../engine/lifecycle'
import type { WriteAdmission } from '../../engine/mutations'
import { resolveRunnableConfig } from '../../engine/startup-checks'
import { getLanguage } from '../../languages/registry'
import type { Narsil } from '../../narsil'
import { createNarsilFromCore } from '../../narsil'
import {
  type PartitionQueryStats,
  runEngineListDocuments,
  runEnginePreflight,
  runEngineQuery,
  runEngineQueryStats,
  runEngineSuggest,
} from '../../narsil/reads'
import { persistedPosition, restartPartitionLog } from '../../persistence/durability/partition-log'
import type { EntryNumbering, PartitionLogPosition } from '../../persistence/durability/types'
import type { NarsilConfig } from '../../types/config'
import type { ByteSource } from '../../types/engine'
import type { GlobalStatistics } from '../../types/internal'
import type { ListResult, PartitionStatsResult, PreflightResult, QueryResult, SuggestResult } from '../../types/results'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
import type { ReplicationLogEntry } from '../replication/types'
import { createHeldPartitionRecord } from './held-partitions'
import { applyLocalReplicationEntry } from './local-replication'
import type { IndexWriteAnalysis } from './memory/document-bound'
import { archiveReplicationPartition, type PartitionArchive, restoreReplicationPartition } from './partition-archive'
import { createEngineWriteAdmission } from './write-admission'

export interface ClusterLocalEngine extends Narsil {
  createIndexWithUuid(name: string, config: IndexConfig, indexUuid?: string): Promise<void>
  acquireIndexForReplication(indexName: string): Promise<() => void>
  indexUuidOf(indexName: string): string | null | undefined
  stampIndexUuid(indexName: string, indexUuid: string): Promise<void>
  highestPersistedSeqNoOf(indexName: string, partitionId: number): number
  persistedPositionOf(indexName: string, partitionId: number): PartitionLogPosition
  numberEntriesWith(numbering: EntryNumbering): void
  admitWritesWith(admission: WriteAdmission): void
  writeAnalysisOf(indexName: string): IndexWriteAnalysis | null
  restartLocalLog(indexName: string, partitionId: number, position: PartitionLogPosition): Promise<void>
  heldPartitionsOf(indexName: string): number[] | undefined
  recordHeldPartition(indexName: string, partitionId: number): Promise<void>
  forgetHeldPartition(indexName: string, partitionId: number): Promise<void>
  applyReplicationEntry(entry: ReplicationLogEntry): Promise<void>
  archiveReplicationPartition(
    indexName: string,
    partitionId: number,
    lastSeqNo: () => number,
  ): Promise<PartitionArchive>
  restoreReplicationPartition(
    indexName: string,
    partitionId: number,
    source: ByteSource,
    config: IndexConfig,
    partitionCount: number,
  ): Promise<void>
  queryPartitions<T = AnyDocument>(
    indexName: string,
    params: QueryParams,
    partitionIds: number[],
    globalStats?: GlobalStatistics,
  ): Promise<QueryResult<T>>
  preflightPartitions(indexName: string, params: QueryParams, partitionIds: number[]): Promise<PreflightResult>
  suggestPartitions(indexName: string, params: SuggestParams, partitionIds: number[]): Promise<SuggestResult>
  listPartitions<T = AnyDocument>(indexName: string, params: ListParams, partitionIds: number[]): Promise<ListResult<T>>
  collectQueryStats(indexName: string, terms: string[], partitionIds: number[]): Promise<PartitionQueryStats>
  partitionStatsForRead(indexName: string): Promise<PartitionStatsResult[]>
}

/**
 * Builds the engine one cluster node uses for its local partitions.
 *
 * @param config - Settings for this node's engine.
 * @param hooks - Node-local callbacks the engine runs after an index reopens and after it closes.
 * @returns The local engine, including partition-scoped cluster operations.
 */
export async function createClusterLocalEngine(
  config?: NarsilConfig,
  hooks?: {
    onIndexOpen?(indexName: string): void | Promise<void>
    onIndexClose?(indexName: string): void | Promise<void>
  },
): Promise<ClusterLocalEngine> {
  requireKnownConfig(config)
  const runnableConfig = await resolveRunnableConfig(config)
  const core = await createEngineCore(runnableConfig, hooks, 'partition')
  await startEngineCore(core, runnableConfig)
  core.orchestrator.shareMainThread()
  const engine = createNarsilFromCore(core, runnableConfig)
  const heldPartitions = createHeldPartitionRecord(core)

  return Object.assign(engine, {
    createIndex: (name: string, indexConfig: IndexConfig) =>
      createEngineIndex(core, runnableConfig, name, indexConfig, { adapterBinding: 'deferred' }),
    createIndexWithUuid: (name: string, indexConfig: IndexConfig, indexUuid?: string) =>
      createEngineIndex(core, runnableConfig, name, indexConfig, { indexUuid }),
    acquireIndexForReplication: (indexName: string) => core.indexState.acquire(indexName, false),
    indexUuidOf: (indexName: string) => core.indexRegistry.get(indexName)?.indexUuid,
    stampIndexUuid: (indexName: string, indexUuid: string) => stampIndexUuid(core, indexName, indexUuid),
    highestPersistedSeqNoOf: (indexName: string, partitionId: number) =>
      core.durability?.manager.highestPersistedSeqNo(indexName, partitionId) ?? 0,
    persistedPositionOf: (indexName: string, partitionId: number) => persistedPositionOf(core, indexName, partitionId),
    numberEntriesWith: (numbering: EntryNumbering) => core.durability?.manager.numberEntriesWith?.(numbering),
    admitWritesWith: (admission: WriteAdmission) => core.admitWritesWith(createEngineWriteAdmission(core, admission)),
    writeAnalysisOf: (indexName: string) => writeAnalysisOf(core, indexName),
    restartLocalLog: (indexName: string, partitionId: number, position: PartitionLogPosition) =>
      restartLocalLog(core, indexName, partitionId, position),
    heldPartitionsOf: (indexName: string) => heldPartitions.held(indexName),
    recordHeldPartition: (indexName: string, partitionId: number) => heldPartitions.record(indexName, partitionId),
    forgetHeldPartition: (indexName: string, partitionId: number) => heldPartitions.forget(indexName, partitionId),
    applyReplicationEntry: (entry: ReplicationLogEntry) => applyLocalReplicationEntry(core, entry),
    archiveReplicationPartition: (indexName: string, partitionId: number, lastSeqNo: () => number) =>
      archiveReplicationPartition(core, indexName, partitionId, lastSeqNo),
    restoreReplicationPartition: (
      indexName: string,
      partitionId: number,
      source: ByteSource,
      indexConfig: IndexConfig,
      partitionCount: number,
    ) => restoreReplicationPartition(core, engine, indexName, partitionId, source, indexConfig, partitionCount),
    queryPartitions: <T = AnyDocument>(
      indexName: string,
      params: QueryParams,
      partitionIds: number[],
      globalStats?: GlobalStatistics,
    ) => runEngineQuery<T>(core, indexName, params, { partitionIds, globalStats }),
    preflightPartitions: (indexName: string, params: QueryParams, partitionIds: number[]) =>
      runEnginePreflight(core, indexName, params, { partitionIds }),
    suggestPartitions: (indexName: string, params: SuggestParams, partitionIds: number[]) =>
      runEngineSuggest(core, indexName, params, partitionIds),
    listPartitions: <T = AnyDocument>(indexName: string, params: ListParams, partitionIds: number[]) =>
      runEngineListDocuments<T>(core, indexName, params, partitionIds),
    collectQueryStats: (indexName: string, terms: string[], partitionIds: number[]) =>
      runEngineQueryStats(core, indexName, terms, partitionIds),
    partitionStatsForRead: async (indexName: string) => {
      const release = await core.indexState.acquire(indexName)
      try {
        return core.requireManager(indexName).getPartitionStats()
      } finally {
        release()
      }
    },
  })
}

function writeAnalysisOf(core: EngineCore, indexName: string): IndexWriteAnalysis | null {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined) return null
  const manager = core.executor.getManager(indexName)
  const language = manager?.language ?? getLanguage(entry.config.language ?? 'english')
  const customTokenizer = (manager?.analysis ?? resolveIndexAnalysis(entry.config)).customTokenizer
  return {
    schema: entry.config.schema,
    language,
    ...(customTokenizer === undefined ? {} : { customTokenizer }),
  }
}

function persistedPositionOf(core: EngineCore, indexName: string, partitionId: number): PartitionLogPosition {
  const durable = core.durability?.manager
  if (durable === undefined) return { seqNo: 0, primaryTerm: 0 }
  return persistedPosition(durable, indexName, partitionId)
}

async function restartLocalLog(
  core: EngineCore,
  indexName: string,
  partitionId: number,
  position: PartitionLogPosition,
): Promise<void> {
  const durable = core.durability?.manager
  if (durable === undefined) return
  const release = await core.indexState.acquire(indexName, false)
  try {
    await restartPartitionLog(durable, indexName, partitionId, position)
  } finally {
    release()
  }
}

async function stampIndexUuid(core: EngineCore, indexName: string, indexUuid: string): Promise<void> {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined || entry.indexUuid === indexUuid) {
    return
  }
  core.indexRegistry.set(indexName, { ...entry, indexUuid })
  if (core.durability !== null) {
    await core.durability.manager.persistMetadata(indexName)
  }
}
