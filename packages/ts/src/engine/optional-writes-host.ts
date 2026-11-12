import type * as SegmentCodecCode from '../core/segment-codec-leaf'
import type { OptionalCodeHost } from './optional-code-host'

export { readHeapStatistics } from '#platform/heap-statistics'
export {
  changeIndexOutsideExternalWaits,
  indexChangeOutsideExternalWaits,
  turnIsSpent,
  turnsAreBudgeted,
  yieldTurn,
} from '#platform/turn-budget'
export { fnv1a } from '../core/hash'
export { generateId } from '../core/id-generator'
export { createFrozenSegment } from '../core/partition/frozen'
export { createSharedFrozenSegment } from '../core/partition/frozen/shared'
export { getNestedValue } from '../core/partition/utils'
export { ErrorCodes, NarsilError } from '../errors'
export { getLanguage } from '../languages/registry'
export { loadStorageCode } from '../persistence/storage-code'
export { validateEmbeddingConfig } from '../schema/embedding-validator'
export {
  requireDocumentWithinSizeLimit,
  validateDocument,
  validateDocumentStrict,
  validateRequiredFields,
  validateSchema,
  validateTextStorage,
  validateVectorStorage,
} from '../schema/validator'
export { storedBM25Params, validateBM25Params } from '../search/bm25-params'
export { isSyncEpoch, newSyncEpoch } from '../sync/epoch'
export { loadSchemaCodeFor } from '../workers/schema-code'
export { arrayPositionsAreStale } from './array-positions'
export { BATCH_CHUNK_SIZE, MIN_DOCUMENTS_FOR_SEGMENTS } from './constants'
export { loadEmbedCode } from './embed-code'
export { insertDocument } from './mutations/insert'
export {
  admitBufferedUpsert,
  admitInsert,
  asBatchInsertError,
  createPendingAdmissions,
  providedDocId,
  recordPendingAdmission,
  requireDocumentObject,
  requireMatchingDocId,
} from './mutations/insert-admission'
export { prepareDocumentWrite, prepareDocumentWrites } from './mutations/write-preparation'
export { awaitWriteVisibility } from './mutations/write-visibility'
export { reconstructSchemaFromMetadata } from './recovery-schema'
export { oneAtATime, withOpenIndex } from './serial-index-update'
export { emitSyncChange } from './sync-notify'
export { lookupOfStoredSynonyms, prepareStoredSynonyms } from './synonym-sets'
export {
  requireSurfaceFormsForPartialFields,
  validateBatchList,
  validateDocId,
  validatePartitionConfig,
  validatePatternValueLimit,
} from './validation'
export {
  deleteNestedValue,
  extractVectorFromDoc,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  updateDocumentVectors,
  validateVectorDimensions,
} from './vector-coordinator'
export { getVectorFieldPaths } from './vector-fields'

export function bindOptionalWritesHost(_host: OptionalCodeHost, _segmentCodec: typeof SegmentCodecCode): void {}
