import { isWordIndexedBase, type SchemaField, schemaFieldsOf } from '../../schema/validator'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import { indexStringArrayField, indexStringField } from './indexing'
import { getNestedValue, type PartitionInsertOptions, type PartitionState } from './utils'

const EMPTY_STATS = {
  totalDocuments: 0,
  totalFieldLengths: {},
  averageFieldLengths: {},
  docFrequencies: {},
}

function textFieldsOf(fields: readonly SchemaField[]): SchemaField[] {
  return fields.filter(field => isWordIndexedBase(field.base))
}

export function rebuildTextIndex(
  state: PartitionState,
  schema: SchemaDefinition,
  language: LanguageModule,
  options?: PartitionInsertOptions,
): void {
  const textFields = textFieldsOf(schemaFieldsOf(schema))

  state.invertedIdx.clear()
  state.surfaceRegistry.clear()
  state.stats.deserialize(EMPTY_STATS)

  state.invertedIdx.beginBatch()
  try {
    for (const [docId, stored] of state.docStore.all()) {
      const internalId = state.docStore.getInternalId(docId)
      if (internalId === undefined) continue

      const fields = stored.fields as Record<string, unknown>
      const fieldLengths: Record<string, number> = {}
      const tokensByField: Record<string, string[]> = {}

      for (const { path: fieldPath, base } of textFields) {
        const value = getNestedValue(fields, fieldPath)
        if (value === undefined || value === null) continue
        if (base === 'string') {
          indexStringField(
            state,
            internalId,
            fieldPath,
            value as string,
            language,
            options,
            fieldLengths,
            tokensByField,
          )
        } else {
          indexStringArrayField(
            state,
            internalId,
            fieldPath,
            value as string[],
            language,
            options,
            fieldLengths,
            tokensByField,
          )
        }
      }

      state.docStore.storeRef(docId, stored.fields as AnyDocument, fieldLengths)
      state.stats.addDocument(fieldLengths, tokensByField)
    }
  } finally {
    state.invertedIdx.endBatch()
  }
}
