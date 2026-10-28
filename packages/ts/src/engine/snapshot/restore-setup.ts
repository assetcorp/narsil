import { resolveIndexAnalysis } from '../../analysis/registry'
import { getLanguage } from '../../languages/registry'
import type { PartitionManager } from '../../partitioning/manager'
import { validateEmbeddingConfig, validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
import { validateSchema, validateVectorPromotion, validateVectorStorage } from '../../schema/validator'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import type { DetachedIndex, DirectExecutorExtensions, IndexReplacement } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { StaleIndex } from '../analysis-rebuild'
import type { IndexRegistryEntry } from '../core'
import type { DurabilityIntegration } from '../durability-integration'
import type { IndexStateCoordinator } from '../index-state'
import type { WorkerOrchestrator } from '../orchestration/types'
import { requireSurfaceFormsForPartialFields, validatePatternValueLimit } from '../validation'
import {
  type ConfigFieldRejection,
  restoredConfigFields,
  restoredEmbedding,
  type SnapshotEnvelope,
} from './restore-config'

export interface RestoreDeps {
  executor: Executor & DirectExecutorExtensions & IndexReplacement
  indexRegistry: Map<string, IndexRegistryEntry>
  getVectorFieldPaths: (schema: SchemaDefinition) => Set<string>
  announceIndexCreated: (name: string, config: IndexConfig) => Promise<void>
  announceIndexDropped: (name: string, config: IndexConfig) => Promise<void>
  durability: DurabilityIntegration | null
  filesystemDurability: boolean
  embeddingAdapters: Map<string, EmbeddingAdapter>
  defaultEmbeddingAdapter: EmbeddingAdapter | null
  markAnalysisStale: (index: StaleIndex) => void
  clearAnalysisStale: (indexName: string) => void
  abandonAnalysisRebuild: (indexName: string) => Promise<void>
  indexState: Pick<IndexStateCoordinator, 'replace' | 'registerReplacing'>
  copies: Pick<WorkerOrchestrator, 'desyncIndex' | 'releaseIndexCopies' | 'endCopyRelease' | 'resyncIndex'>
  forgetWatermark: (indexName: string) => void
  releaseTimeoutMs: number
}

export interface PreparedIndex {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
  adapterName: string | null
  storedRevision: string | null
}

export function prepareRestoredIndex(
  configuration: SnapshotEnvelope,
  deps: RestoreDeps,
  reject?: ConfigFieldRejection,
): PreparedIndex {
  const configFields = restoredConfigFields(configuration, reject)
  const embedding = restoredEmbedding(configuration.embedding, reject)
  const languageName = configuration.language ?? ''
  const language = getLanguage(languageName)
  const schema = validateSchema(configuration.schema as SchemaDefinition)
  validatePatternValueLimit(configFields.patternValueLimit)
  requireSurfaceFormsForPartialFields(schema, configFields.surfaceForms)
  validateVectorPromotion(configFields.vectorPromotion)
  validateVectorStorage(configFields.vectorPromotion, deps.filesystemDurability)
  if (configFields.required !== undefined && configFields.required.length > 0) {
    validateRequiredFieldsInSchema(configFields.required, schema)
  }
  const config: IndexConfig = {
    schema,
    language: languageName,
    ...configFields,
    ...(embedding !== undefined
      ? {
          embedding: {
            fields: embedding.fields,
            ...(embedding.adapter !== undefined ? { adapter: embedding.adapter } : {}),
          },
        }
      : {}),
  }
  resolveIndexAnalysis(config)
  const adapterName = embedding?.adapter ?? null
  let embeddingAdapter: EmbeddingAdapter | null = null
  if (embedding !== undefined) {
    const candidate =
      adapterName !== null ? (deps.embeddingAdapters.get(adapterName) ?? null) : deps.defaultEmbeddingAdapter
    if (candidate) {
      validateEmbeddingConfig({ fields: embedding.fields, adapter: candidate }, schema, undefined)
      embeddingAdapter = candidate
    }
  }
  const storedRevision = typeof configuration.analysisRevision === 'string' ? configuration.analysisRevision : null
  return { config, language, embeddingAdapter, adapterName, storedRevision }
}

export function prepareDetachedIndex(
  indexName: string,
  prepared: PreparedIndex,
  partitionCount: number,
  deps: RestoreDeps,
): DetachedIndex {
  const detached = deps.executor.prepareDetachedIndex(indexName, prepared.config, prepared.language)
  while (detached.manager.partitionCount < partitionCount) detached.manager.addPartition()
  return detached
}

export function restoredRegistryEntry(
  prepared: PreparedIndex,
  manager: PartitionManager,
  deps: RestoreDeps,
): IndexRegistryEntry {
  return {
    config: prepared.config,
    language: prepared.language,
    embeddingAdapter: prepared.embeddingAdapter,
    embeddingAdapterName: prepared.adapterName,
    vectorFieldPaths: deps.getVectorFieldPaths(prepared.config.schema),
    indexUuid: null,
    heldPartitions: null,
    documentCount: manager.countDocuments(),
    partitionCount: manager.partitionCount,
    analysisRevision: prepared.storedRevision,
  }
}
