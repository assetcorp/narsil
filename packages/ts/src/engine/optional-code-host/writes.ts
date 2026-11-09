import { readHeapStatistics } from '#platform/heap-statistics'
import {
  changeIndexOutsideExternalWaits,
  indexChangeOutsideExternalWaits,
  turnsAreBudgeted,
} from '#platform/turn-budget'
import { fnv1a } from '../../core/hash'
import { generateId } from '../../core/id-generator'
import { createFrozenSegment } from '../../core/partition/frozen'
import { getLanguage } from '../../languages/registry'
import { loadStorageCode } from '../../persistence/storage-code'
import { validateEmbeddingConfig } from '../../schema/embedding-validator'
import {
  requireDocumentWithinSizeLimit,
  validateDocument,
  validateDocumentStrict,
  validateRequiredFields,
  validateSchema,
  validateTextStorage,
  validateVectorStorage,
} from '../../schema/validator'
import { storedBM25Params, validateBM25Params } from '../../search/bm25-params'
import { isSyncEpoch, newSyncEpoch } from '../../sync/epoch'
import { loadSchemaCodeFor } from '../../workers/schema-code'
import { arrayPositionsAreStale } from '../array-positions'
import { BATCH_CHUNK_SIZE, MIN_DOCUMENTS_FOR_SEGMENTS } from '../constants'
import { loadEmbedCode } from '../embed-code'
import { insertDocument } from '../mutations/insert'
import {
  admitBufferedUpsert,
  admitInsert,
  asBatchInsertError,
  collectRequiredFieldFailures,
  createPendingAdmissions,
  embedChunkDocuments,
  providedDocId,
  recordPendingAdmission,
  requireDocumentObject,
  requireMatchingDocId,
} from '../mutations/insert-admission'
import { awaitWriteVisibility } from '../mutations/write-visibility'
import { loadOptionalWrites } from '../optional-writes-code'
import { oneAtATime, withOpenIndex } from '../serial-index-update'
import { emitSyncChange } from '../sync-notify'
import { lookupOfStoredSynonyms, prepareStoredSynonyms } from '../synonym-sets'
import {
  requireSurfaceFormsForPartialFields,
  validateBatchList,
  validateDocId,
  validatePartitionConfig,
  validatePatternValueLimit,
} from '../validation'
import {
  deleteNestedValue,
  extractVectorFromDoc,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  updateDocumentVectors,
  validateVectorDimensions,
} from '../vector-coordinator'
import { getVectorFieldPaths } from '../vector-fields'

export function writesHostPart() {
  return {
    BATCH_CHUNK_SIZE,
    MIN_DOCUMENTS_FOR_SEGMENTS,
    admitBufferedUpsert,
    admitInsert,
    arrayPositionsAreStale,
    asBatchInsertError,
    awaitWriteVisibility,
    changeIndexOutsideExternalWaits,
    collectRequiredFieldFailures,
    createFrozenSegment,
    createPendingAdmissions,
    deleteNestedValue,
    embedChunkDocuments,
    emitSyncChange,
    extractVectorFromDoc,
    fnv1a,
    generateId,
    getLanguage,
    getVectorFieldPaths,
    indexChangeOutsideExternalWaits,
    insertDocument,
    insertDocumentVectors,
    isSyncEpoch,
    loadEmbedCode,
    loadSchemaCodeFor,
    loadOptionalWrites,
    loadStorageCode,
    lookupOfStoredSynonyms,
    newSyncEpoch,
    oneAtATime,
    prepareDocumentVectors,
    prepareStoredSynonyms,
    providedDocId,
    readHeapStatistics,
    recordPendingAdmission,
    removeDocumentVectors,
    requireDocumentObject,
    requireDocumentWithinSizeLimit,
    requireMatchingDocId,
    requireSurfaceFormsForPartialFields,
    storedBM25Params,
    turnsAreBudgeted,
    updateDocumentVectors,
    validateBM25Params,
    validateBatchList,
    validateDocId,
    validateDocument,
    validateDocumentStrict,
    validateEmbeddingConfig,
    validatePartitionConfig,
    validatePatternValueLimit,
    validateRequiredFields,
    validateSchema,
    validateTextStorage,
    validateVectorDimensions,
    validateVectorStorage,
    withOpenIndex,
  }
}
