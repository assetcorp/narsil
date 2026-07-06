import { ErrorCodes, NarsilError } from '../errors'
import type { EmbeddingFieldConfig, IndexConfig, SchemaDefinition } from '../types/schema'
import type { HttpIndexConfig } from './types'

/**
 * Translates the declarative JSON index config accepted over HTTP into the
 * engine's {@link IndexConfig}. Function-valued engine options (custom
 * tokenizer, stopWords-as-function, group reducer, embedding adapter object)
 * cannot cross JSON; `stopWords` arrives as an array and is rebuilt into a Set.
 * The embedding adapter name passes through untouched: the engine resolves it
 * against its adapter registry, which also lets the name persist in durability
 * metadata. Schema and field-level validation stays with the engine's
 * createIndex.
 */
export function mapHttpIndexConfig(http: HttpIndexConfig): IndexConfig {
  if (typeof http !== 'object' || http === null) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Index config must be an object')
  }
  if (typeof http.schema !== 'object' || http.schema === null || Array.isArray(http.schema)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Index config requires a "schema" object')
  }

  const config: IndexConfig = { schema: http.schema as SchemaDefinition }

  if (http.language !== undefined) config.language = http.language
  if (http.partitions !== undefined) config.partitions = http.partitions
  if (http.defaultScoring !== undefined) config.defaultScoring = http.defaultScoring
  if (http.bm25 !== undefined) config.bm25 = http.bm25
  if (http.trackPositions !== undefined) config.trackPositions = http.trackPositions
  if (http.surfaceForms !== undefined) config.surfaceForms = http.surfaceForms === true
  if (http.vectorPromotion !== undefined) config.vectorPromotion = http.vectorPromotion
  if (http.strict !== undefined) config.strict = http.strict
  if (http.required !== undefined) config.required = http.required

  if (http.stopWords !== undefined) {
    if (!Array.isArray(http.stopWords) || http.stopWords.some(w => typeof w !== 'string')) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Field "stopWords" must be an array of strings')
    }
    config.stopWords = new Set(http.stopWords)
  }

  if (http.embedding !== undefined) {
    config.embedding = mapEmbedding(http.embedding)
  }

  return config
}

function mapEmbedding(embedding: NonNullable<HttpIndexConfig['embedding']>): EmbeddingFieldConfig {
  if (typeof embedding !== 'object' || embedding === null) {
    throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, 'Field "embedding" must be an object')
  }
  if (typeof embedding.fields !== 'object' || embedding.fields === null) {
    throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, 'Field "embedding.fields" is required')
  }
  const mapped: EmbeddingFieldConfig = { fields: embedding.fields }
  if (embedding.adapter !== undefined) {
    if (typeof embedding.adapter !== 'string' || embedding.adapter.length === 0) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_CONFIG_INVALID,
        'Field "embedding.adapter" must be a non-empty adapter name',
      )
    }
    mapped.adapter = embedding.adapter
  }
  return mapped
}
