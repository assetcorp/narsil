import { copyStoredValue } from '#platform/stored-value-copy'
import { ErrorCodes, NarsilError } from '../../errors'
import { partialFieldsOf, schemaFieldsOf, validateDocument, validateDocumentStrict } from '../../schema/validator'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import { prepareStoredValues } from '../stored-values/columns'
import { updateFieldIndexOnly } from './field-updates'
import { indexDocument, removeFromIndexes } from './indexing'
import { keywordCountsFit, prepareKeywordSegment } from './keyword-writes'
import type { PartitionIndex } from './partition-index'
import { prepareDocumentText } from './prepared-text'
import { SegmentFull } from './segment-full'
import { forgetSortValues, recordSortValues } from './sorting'
import { type PartitionInsertOptions, type PartitionState, textFieldsChanged } from './utils'

export function createPartitionMutations(
  state: PartitionState,
  partitionId: number,
): Pick<PartitionIndex, 'insert' | 'remove' | 'update'> {
  return {
    insert(
      docId: string,
      document: AnyDocument,
      schema: SchemaDefinition,
      language: LanguageModule,
      options?: PartitionInsertOptions,
    ): AnyDocument {
      if (state.docStore.has(docId)) {
        throw new NarsilError(
          ErrorCodes.DOC_ALREADY_EXISTS,
          `Document "${docId}" already exists in partition ${partitionId}`,
          { docId, partitionId },
        )
      }

      if (options?.validate !== false) {
        validateDocument(document, schema, options?.patternValueLimit)
        if (options?.strict) {
          validateDocumentStrict(document as Record<string, unknown>, schema)
        }
      }

      if (options?.skipClone !== true) document = copyStoredValue(document) as AnyDocument
      const fields = schemaFieldsOf(schema)
      prepareKeywordSegment(state, fields, language, options)
      const prepared =
        options?.preparedText?.after ??
        prepareDocumentText(document as Record<string, unknown>, fields, language, options)
      options?.onPreparedText?.({ after: prepared })
      const applyValues = prepareStoredValues(
        state.docStore,
        undefined,
        state.docStore.getInternalId(docId) ?? state.docStore.internalIdCapacity(),
        document,
      )
      const internalId = state.docStore.ensureInternalId(docId)
      try {
        indexDocument(state, internalId, document as Record<string, unknown>, fields, prepared)
      } catch (error) {
        if (error instanceof SegmentFull) {
          state.docStore.remove(docId)
          throw new SegmentFull({ ...options?.preparedText, after: prepared })
        }
        throw error
      }
      const { fieldLengths, tokens, partialSpellings } = prepared
      const stored = options?.skipClone
        ? state.docStore.storeRef(docId, document, fieldLengths)
        : state.docStore.store(docId, document, fieldLengths)
      applyValues()
      state.stats.addDocument(fieldLengths, tokens)
      state.partialWords.afterDocument(partialFieldsOf(schema), internalId, partialSpellings, 1)
      recordSortValues(state, internalId, document as Record<string, unknown>)
      return stored
    },

    remove(docId: string, schema: SchemaDefinition, language: LanguageModule, options?: PartitionInsertOptions): void {
      const stored = state.docStore.get(docId)
      if (!stored) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in partition ${partitionId}`, {
          docId,
          partitionId,
        })
      }

      const fields = schemaFieldsOf(schema)
      prepareKeywordSegment(state, fields, language, options)
      const prepared = options?.preparedText?.before ?? prepareDocumentText(stored.fields, fields, language, options)
      options?.onPreparedText?.({ before: prepared })
      const internalId = state.docStore.getInternalId(docId)
      if (internalId === undefined)
        throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'A stored document has no internal ID')
      const applyValues = prepareStoredValues(state.docStore, internalId, undefined)
      removeFromIndexes(state, internalId, stored.fields, fields, prepared)
      const { fieldLengths, tokens, partialSpellings } = prepared
      state.docStore.remove(docId)
      applyValues()
      state.stats.removeDocument(fieldLengths, tokens)
      state.partialWords.afterDocument(partialFieldsOf(schema), internalId, partialSpellings, -1)
      forgetSortValues(state, internalId)
    },

    update(
      docId: string,
      document: AnyDocument,
      schema: SchemaDefinition,
      language: LanguageModule,
      options?: PartitionInsertOptions,
    ): AnyDocument {
      const stored = state.docStore.get(docId)
      if (!stored) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in partition ${partitionId}`, {
          docId,
          partitionId,
        })
      }

      if (options?.validate !== false) {
        validateDocument(document, schema, options?.patternValueLimit)
        if (options?.strict) {
          validateDocumentStrict(document as Record<string, unknown>, schema)
        }
      }

      const fields = schemaFieldsOf(schema)
      const needsTextReindex = textFieldsChanged(stored.fields, document as Record<string, unknown>, fields)

      if (options?.skipClone !== true) document = copyStoredValue(document) as AnyDocument

      if (needsTextReindex) {
        prepareKeywordSegment(state, fields, language, options)
        const previous = options?.preparedText?.before ?? prepareDocumentText(stored.fields, fields, language, options)
        const next =
          options?.preparedText?.after ??
          prepareDocumentText(document as Record<string, unknown>, fields, language, options)
        options?.onPreparedText?.({ before: previous, after: next })
        if (!keywordCountsFit(state, next)) throw new SegmentFull({ before: previous, after: next })
        const previousInternalId = state.docStore.getInternalId(docId)
        if (previousInternalId === undefined)
          throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'A stored document has no internal ID')
        const applyValues = prepareStoredValues(
          state.docStore,
          previousInternalId,
          state.docStore.internalIdCapacity(),
          document,
        )
        removeFromIndexes(state, previousInternalId, stored.fields, fields, previous)
        state.stats.removeDocument(previous.fieldLengths, previous.tokens)
        state.partialWords.afterDocument(partialFieldsOf(schema), previousInternalId, previous.partialSpellings, -1)
        state.docStore.remove(docId)
        forgetSortValues(state, previousInternalId)
        const internalId = state.docStore.ensureInternalId(docId)

        indexDocument(state, internalId, document as Record<string, unknown>, fields, next)
        const written = state.docStore.store(docId, document, next.fieldLengths)
        applyValues()
        state.stats.addDocument(next.fieldLengths, next.tokens)
        state.partialWords.afterDocument(partialFieldsOf(schema), internalId, next.partialSpellings, 1)
        recordSortValues(state, internalId, document as Record<string, unknown>)
        return written
      }
      const ordinal = state.docStore.getInternalId(docId)
      const applyValues = prepareStoredValues(state.docStore, undefined, ordinal, document)
      updateFieldIndexOnly(state, docId, stored.fields, document as Record<string, unknown>, fields)
      const written = state.docStore.store(docId, document, stored.fieldLengths)
      applyValues()
      const internalId = state.docStore.getInternalId(docId)
      if (internalId !== undefined) recordSortValues(state, internalId, document as Record<string, unknown>)
      return written
    },
  }
}
