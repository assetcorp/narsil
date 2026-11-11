import {
  arrayPositionsAreStale,
  ErrorCodes,
  getLanguage,
  getVectorFieldPaths,
  loadSchemaCodeFor,
  loadStorageCode,
  lookupOfStoredSynonyms,
  NarsilError,
  prepareStoredSynonyms,
  reconstructSchemaFromMetadata,
  requireSurfaceFormsForPartialFields,
  validateEmbeddingConfig,
  validatePatternValueLimit,
  validateSchema,
  validateTextStorage,
  validateVectorStorage,
} from '#platform/optional-writes-host'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { SchemaDefinition } from '../types/schema'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import type { AnalysisRebuildCoordinator } from './analysis-rebuild'
import type { IndexRegistryEntry } from './core'
import type { IndexStateCoordinator } from './index-state'
import { syncStateOfMetadata } from './sync-state'

function isRecoveryConfigError(err: unknown): err is NarsilError {
  return (
    err instanceof NarsilError &&
    (err.code === ErrorCodes.CONFIG_INVALID ||
      err.code === ErrorCodes.SCHEMA_INVALID_TYPE ||
      err.code === ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION)
  )
}

export interface MetadataIndexDeps {
  config: NarsilConfig | undefined
  executor: Executor & DirectExecutorExtensions
  indexRegistry: Map<string, IndexRegistryEntry>
  embeddingAdapters: Map<string, EmbeddingAdapter>
  filesystemDurability: boolean
  indexState: () => Pick<IndexStateCoordinator, 'registerOpen' | 'registerClosed'>
  analysisRebuild: () => Pick<AnalysisRebuildCoordinator, 'markStale'>
}

function resolveEmbeddingAdapter(
  deps: MetadataIndexDeps,
  metadata: IndexMetadata,
  schema: SchemaDefinition,
): { adapter: EmbeddingAdapter | null; name: string | null } {
  const name = metadata.embedding?.adapter ?? null
  if (!metadata.embedding) return { adapter: null, name }
  const candidate = name !== null ? (deps.embeddingAdapters.get(name) ?? null) : (deps.config?.embedding ?? null)
  if (!candidate) return { adapter: null, name }
  try {
    validateEmbeddingConfig({ fields: metadata.embedding.fields, adapter: candidate }, schema, undefined)
  } catch (err) {
    if (err instanceof NarsilError) {
      throw new NarsilError(err.code, `Recovery of index "${metadata.indexName}" failed: ${err.message}`, {
        indexName: metadata.indexName,
        adapter: name ?? undefined,
      })
    }
    throw err
  }
  return { adapter: candidate, name }
}

function recoveryFailure(metadata: IndexMetadata, err: unknown): unknown {
  if (!isRecoveryConfigError(err)) return err
  return new NarsilError(err.code, `Recovery of index "${metadata.indexName}" failed: ${err.message}`, {
    ...err.details,
    indexName: metadata.indexName,
    tokenizer: metadata.tokenizer,
    stopWords: metadata.stopWords,
  })
}

async function savedPartitionCountOf(metadata: IndexMetadata): Promise<number> {
  const count: unknown = metadata.partitionCount
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    const held = typeof count === 'number' ? String(count) : `a ${typeof count} as its count of`
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Recovery of index "${metadata.indexName}" failed: its metadata holds ${held} partitions, and an index holds a whole number above zero`,
      { indexName: metadata.indexName, partitionCount: typeof count === 'number' ? count : typeof count },
    )
  }
  const { requireSavedPartitionCount } = await loadStorageCode()
  requireSavedPartitionCount(count, 'metadata', metadata.indexName)
  return count
}

export async function createIndexFromMetadata(
  deps: MetadataIndexDeps,
  metadata: IndexMetadata,
  loadData: boolean,
): Promise<void> {
  const loadingSchemaCode = loadSchemaCodeFor(
    loadData ? metadata.schema : null,
    metadata.tokenizer,
    metadata.pendingAnalysis?.tokenizer,
  )
  if (loadingSchemaCode !== null) await loadingSchemaCode
  const existing = deps.indexRegistry.get(metadata.indexName)
  if (existing !== undefined) {
    if ((metadata.analysisGeneration ?? 0) > existing.analysisGeneration) {
      const { adoptSavedAnalysis } = await loadStorageCode()
      adoptSavedAnalysis(deps.executor.getManager(metadata.indexName), existing, metadata)
    }
    if (loadData && deps.executor.getManager(metadata.indexName) === undefined) {
      const partitionCount = await savedPartitionCountOf(metadata)
      deps.executor.createIndex(
        metadata.indexName,
        existing.config,
        existing.language,
        false,
        lookupOfStoredSynonyms(existing.synonyms, existing.config, existing.language),
        partitionCount,
      )
    }
    return
  }
  const indexConfig = reconstructSchemaFromMetadata(metadata)
  const language = getLanguage(indexConfig.language ?? 'english')
  try {
    indexConfig.schema = validateSchema(indexConfig.schema)
    validatePatternValueLimit(indexConfig.patternValueLimit)
    requireSurfaceFormsForPartialFields(indexConfig.schema, indexConfig.surfaceForms)
  } catch (err) {
    throw recoveryFailure(metadata, err)
  }
  const partitionCount = await savedPartitionCountOf(metadata)
  const embedding = resolveEmbeddingAdapter(deps, metadata, indexConfig.schema)
  const prepared = prepareStoredSynonyms(
    metadata.synonyms,
    indexConfig,
    language,
    'The synonym set in the index metadata is invalid: ',
  )
  const synonyms = prepared?.encoded ?? null

  try {
    validateVectorStorage(indexConfig.vectorPromotion, deps.filesystemDurability)
    validateTextStorage(indexConfig.textStorage, deps.filesystemDurability)
    if (loadData) {
      deps.executor.createIndex(
        metadata.indexName,
        indexConfig,
        language,
        false,
        prepared?.lookup ?? null,
        partitionCount,
      )
    }
  } catch (err) {
    throw recoveryFailure(metadata, err)
  }
  deps.indexRegistry.set(metadata.indexName, {
    config: indexConfig,
    language,
    embeddingAdapter: embedding.adapter,
    embeddingAdapterName: embedding.name,
    vectorFieldPaths: getVectorFieldPaths(indexConfig.schema),
    indexUuid: metadata.indexUuid ?? null,
    heldPartitions: metadata.heldPartitions ?? null,
    documentCount: metadata.documentCount ?? 0,
    savedBytes: metadata.savedBytes ?? null,
    partitionCount,
    analysisRevision: metadata.analysisRevision ?? null,
    arrayPositionGap: metadata.arrayPositionGap ?? null,
    synonyms,
    analysisGeneration: metadata.analysisGeneration ?? 0,
    pendingAnalysis: metadata.pendingAnalysis ?? null,
    durableAnalysis: null,
    sync: metadata.sync?.enabled === true ? syncStateOfMetadata(metadata) : null,
    querySuggestions: metadata.querySuggestions ?? null,
  })
  if (loadData) await deps.indexState().registerOpen(metadata.indexName)
  else deps.indexState().registerClosed(metadata.indexName)
  if (
    metadata.analysisRevision !== language.revision ||
    arrayPositionsAreStale(indexConfig, metadata.arrayPositionGap ?? null)
  ) {
    deps.analysisRebuild().markStale({
      indexName: metadata.indexName,
      language: language.name,
      storedRevision: metadata.analysisRevision ?? null,
      currentRevision: language.revision,
    })
  }
}
