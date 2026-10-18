import { resolveIndexAnalysis } from '../../analysis/registry'
import { getLanguage } from '../../languages/registry'
import type { PartitionManager } from '../../partitioning/manager'
import { validateEmbeddingConfig, validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
import { validateSchema, validateVectorPromotion, validateVectorStorage } from '../../schema/validator'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { StaleIndex } from '../analysis-rebuild'
import type { IndexRegistryEntry } from '../core'
import type { DurabilityIntegration } from '../durability-integration'
import type { IndexStateCoordinator } from '../index-state'
import { requireSurfaceFormsForPartialFields, validatePatternValueLimit } from '../validation'
import {
  type ConfigFieldRejection,
  restoredConfigFields,
  restoredEmbedding,
  type SnapshotEnvelope,
} from './restore-config'

export interface RestoreDeps {
  executor: Executor & DirectExecutorExtensions
  indexRegistry: Map<string, IndexRegistryEntry>
  getVectorFieldPaths: (schema: SchemaDefinition) => Set<string>
  dropIndex: (name: string) => Promise<void>
  announceIndexCreated: (name: string, config: IndexConfig) => Promise<void>
  requireManager: (name: string) => PartitionManager
  durability: DurabilityIntegration | null
  filesystemDurability: boolean
  embeddingAdapters: Map<string, EmbeddingAdapter>
  defaultEmbeddingAdapter: EmbeddingAdapter | null
  markAnalysisStale: (index: StaleIndex) => void
  clearAnalysisStale: (indexName: string) => void
  indexState: Pick<IndexStateCoordinator, 'registerOpen' | 'acquire' | 'forget'>
}

export interface PreparedIndex {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
  adapterName: string | null
  storedRevision: string | null
}

export interface CreatedIndex {
  manager: PartitionManager
  release(): void
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

export async function createRestoredIndex(
  indexName: string,
  prepared: PreparedIndex,
  partitionCount: number,
  deps: RestoreDeps,
): Promise<CreatedIndex> {
  if (deps.indexRegistry.has(indexName)) {
    await deps.dropIndex(indexName)
  }
  deps.clearAnalysisStale(indexName)
  if (prepared.storedRevision !== prepared.language.revision) {
    deps.markAnalysisStale({
      indexName,
      language: prepared.language.name,
      storedRevision: prepared.storedRevision,
      currentRevision: prepared.language.revision,
    })
  }
  deps.executor.createIndex(indexName, prepared.config, prepared.language)
  deps.indexRegistry.set(indexName, {
    config: prepared.config,
    language: prepared.language,
    embeddingAdapter: prepared.embeddingAdapter,
    embeddingAdapterName: prepared.adapterName,
    vectorFieldPaths: deps.getVectorFieldPaths(prepared.config.schema),
    indexUuid: null,
    heldPartitions: null,
    documentCount: 0,
    partitionCount,
  })
  await deps.indexState.registerOpen(indexName)
  const release = await deps.indexState.acquire(indexName, false)
  const manager = deps.requireManager(indexName)
  while (manager.partitionCount < partitionCount) manager.addPartition()
  return { manager, release }
}

export async function abandonRestoredIndex(indexName: string, deps: RestoreDeps): Promise<void> {
  try {
    deps.executor.dropIndex(indexName)
  } catch (_) {}
  deps.indexRegistry.delete(indexName)
  deps.indexState.forget(indexName)
  if (deps.durability) {
    await deps.durability.manager.removeIndex(indexName).catch(() => undefined)
  }
}

export function recordRestoredCounts(indexName: string, manager: PartitionManager, deps: RestoreDeps): void {
  const entry = deps.indexRegistry.get(indexName)
  if (entry !== undefined) {
    entry.documentCount = manager.countDocuments()
    entry.partitionCount = manager.partitionCount
  }
}
