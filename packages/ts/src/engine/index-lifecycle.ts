import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import {
  validateEmbeddingConfig,
  validateRegisteredAdapter,
  validateRequiredFieldsInSchema,
} from '../schema/embedding-validator'
import { validateSchema, validateVectorPromotion } from '../schema/validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { IndexConfig } from '../types/schema'
import { type EngineCore, getVectorFieldPaths, type IndexRegistryEntry } from './core'
import { validateIndexName } from './validation'

export async function createEngineIndex(
  core: EngineCore,
  config: NarsilConfig | undefined,
  name: string,
  indexConfig: IndexConfig,
): Promise<void> {
  core.guardShutdown()
  validateIndexName(name)
  if (core.indexRegistry.has(name)) {
    throw new NarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, `Index "${name}" already exists`, { indexName: name })
  }
  validateSchema(indexConfig.schema)
  validateVectorPromotion(indexConfig.vectorPromotion)
  let resolvedEmbeddingAdapter: EmbeddingAdapter | null = null
  let embeddingAdapterName: string | null = null
  if (indexConfig.embedding) {
    let configuredAdapter = indexConfig.embedding.adapter
    if (typeof configuredAdapter === 'string') {
      embeddingAdapterName = configuredAdapter
      const registered = core.embeddingAdapters.get(configuredAdapter)
      if (!registered) {
        throw new NarsilError(
          ErrorCodes.EMBEDDING_CONFIG_INVALID,
          `Embedding adapter "${configuredAdapter}" is not registered on this engine`,
          { adapter: configuredAdapter, available: [...core.embeddingAdapters.keys()] },
        )
      }
      configuredAdapter = registered
    }
    resolvedEmbeddingAdapter = validateEmbeddingConfig(
      { fields: indexConfig.embedding.fields, adapter: configuredAdapter },
      indexConfig.schema,
      config?.embedding,
    )
  }
  if (indexConfig.required && indexConfig.required.length > 0) {
    validateRequiredFieldsInSchema(indexConfig.required, indexConfig.schema)
  }
  const language = getLanguage(indexConfig.language ?? 'english')
  core.executor.createIndex(name, indexConfig, language)
  core.indexRegistry.set(name, {
    config: indexConfig,
    language,
    embeddingAdapter: resolvedEmbeddingAdapter,
    embeddingAdapterName,
    vectorFieldPaths: getVectorFieldPaths(indexConfig.schema),
  })
  if (core.durability) {
    await core.durability.manager.persistMetadata(name)
  }
  await core.pluginRegistry.runHook('onIndexCreate', { indexName: name, config: indexConfig })
}

export async function dropEngineIndex(core: EngineCore, name: string): Promise<void> {
  core.guardShutdown()
  const entry = core.requireIndex(name)
  core.executor.dropIndex(name)
  core.indexRegistry.delete(name)
  if (core.durability) {
    await core.durability.manager.removeIndex(name)
  }
  await core.pluginRegistry.runHook('onIndexDrop', { indexName: name, config: entry.config })
}

export function registerEngineEmbeddingAdapter(core: EngineCore, name: string, adapter: EmbeddingAdapter): void {
  core.guardShutdown()
  validateRegisteredAdapter(name, adapter)
  // Validate every referencing index before any binding changes, so a
  // mismatch leaves the registry and all bindings untouched.
  const affected: IndexRegistryEntry[] = []
  for (const [indexName, entry] of core.indexRegistry) {
    if (entry.embeddingAdapterName !== name || !entry.config.embedding) continue
    try {
      validateEmbeddingConfig({ fields: entry.config.embedding.fields, adapter }, entry.config.schema, undefined)
    } catch (err) {
      if (err instanceof NarsilError) {
        throw new NarsilError(
          err.code,
          `Cannot bind embedding adapter "${name}" to index "${indexName}": ${err.message}`,
          {
            indexName,
            adapter: name,
          },
        )
      }
      throw err
    }
    affected.push(entry)
  }
  core.embeddingAdapters.set(name, adapter)
  for (const entry of affected) {
    entry.embeddingAdapter = adapter
  }
}
