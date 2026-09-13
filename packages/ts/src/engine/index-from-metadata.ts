import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import { validateEmbeddingConfig } from '../schema/embedding-validator'
import { validateVectorStorage } from '../schema/validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { SchemaDefinition } from '../types/schema'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import type { AnalysisRebuildCoordinator } from './analysis-rebuild'
import type { IndexRegistryEntry } from './core'
import type { IndexStateCoordinator } from './index-state'
import { reconstructSchemaFromMetadata } from './recovery-schema'
import { getVectorFieldPaths } from './vector-fields'

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

/**
 * Registers an index the engine's persisted metadata describes, and creates
 * its partitions where the caller asks for its data.
 *
 * @param deps The engine pieces the index registers with.
 * @param metadata The persisted description of the index.
 * @param loadData Whether to create the index's partitions now.
 *
 * @internal
 */
export async function createIndexFromMetadata(
  deps: MetadataIndexDeps,
  metadata: IndexMetadata,
  loadData: boolean,
): Promise<void> {
  const existing = deps.indexRegistry.get(metadata.indexName)
  if (existing !== undefined) {
    if (loadData && deps.executor.getManager(metadata.indexName) === undefined) {
      deps.executor.createIndex(metadata.indexName, existing.config, existing.language)
    }
    return
  }
  const indexConfig = reconstructSchemaFromMetadata(metadata)
  const language = getLanguage(indexConfig.language ?? 'english')
  const embedding = resolveEmbeddingAdapter(deps, metadata, indexConfig.schema)

  try {
    validateVectorStorage(indexConfig.vectorPromotion, deps.filesystemDurability)
    if (loadData) deps.executor.createIndex(metadata.indexName, indexConfig, language)
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.CONFIG_INVALID) {
      throw new NarsilError(err.code, `Recovery of index "${metadata.indexName}" failed: ${err.message}`, {
        indexName: metadata.indexName,
        tokenizer: metadata.tokenizer,
        stopWords: metadata.stopWords,
      })
    }
    throw err
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
    partitionCount: metadata.partitionCount,
  })
  if (loadData) await deps.indexState().registerOpen(metadata.indexName)
  else deps.indexState().registerClosed(metadata.indexName)
  if (metadata.analysisRevision !== language.revision) {
    deps.analysisRebuild().markStale({
      indexName: metadata.indexName,
      language: language.name,
      storedRevision: metadata.analysisRevision ?? null,
      currentRevision: language.revision,
    })
  }
}
