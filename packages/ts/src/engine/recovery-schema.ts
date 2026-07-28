import type { IndexMetadata } from '../types/internal'
import type { FieldType, IndexConfig, SchemaDefinition } from '../types/schema'

function unflattenSchema(flat: Record<string, string>): SchemaDefinition {
  const root: SchemaDefinition = {}
  for (const [path, fieldType] of Object.entries(flat)) {
    const segments = path.split('.')
    let cursor: SchemaDefinition = root
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]
      const existing = cursor[segment]
      if (existing === undefined || typeof existing !== 'object') {
        const child: SchemaDefinition = {}
        cursor[segment] = child
        cursor = child
      } else {
        cursor = existing as SchemaDefinition
      }
    }
    const leaf = segments[segments.length - 1]
    cursor[leaf] = fieldType as FieldType
  }
  return root
}

export function reconstructSchemaFromMetadata(metadata: IndexMetadata): IndexConfig {
  const config: IndexConfig = {
    schema: unflattenSchema(metadata.schema),
    language: metadata.language,
    bm25: { k1: metadata.bm25Params.k1, b: metadata.bm25Params.b },
  }
  if (metadata.embedding) {
    config.embedding =
      metadata.embedding.adapter !== undefined
        ? { adapter: metadata.embedding.adapter, fields: metadata.embedding.fields }
        : { fields: metadata.embedding.fields }
  }
  if (metadata.surfaceForms === true) {
    config.surfaceForms = true
  }
  if (metadata.tokenizer !== undefined) {
    config.tokenizer = metadata.tokenizer
  }
  if (metadata.stopWords !== undefined) {
    config.stopWords = metadata.stopWords
  } else if (metadata.stopWordList !== undefined) {
    config.stopWords = new Set(metadata.stopWordList)
  }
  return config
}
