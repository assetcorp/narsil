import type * as SegmentCodecCode from '../../core/segment-codec-leaf'
import type * as SegmentMergeCode from '../../core/segment-merge-leaf'
import type { OptionalCodeHost } from '../../engine/optional-code-host'
import type * as SuggestionStoreCode from '../../query-suggestions/store-leaf'
import type * as MsgpackCode from '../../serialization/msgpack-leaf'
import type * as VectorCoreCode from '../../vector/core-leaf'
import type * as DigestCode from '../durability/digest-leaf'

export { encode } from '@msgpack/msgpack'
export { readHeapStatistics } from '#platform/heap-statistics'
export { collectAndReturnPages } from '#platform/idle-heap-cleanup'
export { loadNativeCore } from '#platform/native-core'
export { nodeThreadId, spawnNodeWorker } from '#platform/node-worker'
export { readResidentMemory } from '#platform/process-limit'
export { mergePostings } from '#platform/segment-merges'
export { countWrite, turnIsSpent, turnsAreBudgeted, waitOutsideCountedWrite, yieldTurn } from '#platform/turn-budget'
export { createVectorFileReader } from '#platform/vector-file'
export { VERSION } from '../..'
export { resolveIndexAnalysis } from '../../analysis/registry'
export { ARRAY_POSITION_GAP, DEFAULT_BM25_B, DEFAULT_BM25_K1 } from '../../core/constants'
export { createFrozenRemovals, emptyPendingRegions } from '../../core/frozen-writes/publication'
export { fnv1a } from '../../core/hash'
export { generateId } from '../../core/id-generator'
export { compareCodePoints } from '../../core/ordering'
export { compareScores } from '../../core/ordering/scores'
export { createPartitionIndex, partitionStateOf } from '../../core/partition'
export { scanPostingBlocks } from '../../core/partition/block-bounds'
export { createCompositePartition, isCompositePartition } from '../../core/partition/composite'
export { survivorDocumentsOf } from '../../core/partition/composite/compaction'
export { mergeDocFrequencies } from '../../core/partition/composite/stats'
export { assemblePagedFrozenSegment, createFrozenSegment } from '../../core/partition/frozen'
export {
  createEncodedDocumentSource,
  decodeEveryStoredDocument,
  decodeStoredDocument,
} from '../../core/partition/frozen/document-source'
export {
  fieldIndexRemapOf,
  holdsADiscardedField,
  mergeSegmentContents,
  selectionKeeps,
} from '../../core/partition/frozen/merge'
export { mergeFieldIndexes } from '../../core/partition/frozen/merge-fields'
export { prepareRemovalText, removedSurfaceSpellings } from '../../core/partition/frozen/removal-text'
export { createSharedFrozenSegment } from '../../core/partition/frozen/shared'
export { freezeSegmentShared, segmentArraysOf, shareSegmentArrays } from '../../core/partition/frozen/shared-snapshot'
export { decodeSurfaceTable } from '../../core/partition/frozen/surface-table'
export { wrapFrozenTokenTable } from '../../core/partition/frozen/token-table'
export { buildPartialWordTableFrom } from '../../core/partition/partial-words/registry'
export { prepareDocumentText } from '../../core/partition/prepared-text'
export { writePartitionDocument } from '../../core/partition/rollover'
export { buildSegmentPayloads } from '../../core/partition/segment-builder'
export { deserializePartition } from '../../core/partition/serialization'
export { getNestedValue, parseVectorDimension } from '../../core/partition/utils'
export { requireSearchActive, signalOfSearch } from '../../core/search-stop'
export { mergedPartialSpellings, mergeSourceSpellings, mergeSourceSurfaces } from '../../core/segment-merges/host'
export { mergeKeywordSources } from '../../core/segment-merges/output'
export { SegmentRefusal } from '../../core/segment-writes/status'
export { TermLookup } from '../../core/term-table/lookup'
export { arrayPositionsAreStale, storedArrayPositionGap } from '../../engine/array-positions'
export {
  ANALYSIS_CHANGE_MEMBERS,
  ANALYSIS_HOLD_APPLY_INTERVAL_MS,
  DEFAULT_MAX_PARTITIONS,
  EXPORT_CHUNK_BYTES,
  FOREIGN_STATS_TTL_MS,
  IMPORT_BATCH_DOCUMENTS,
  INDEX_NAME_PATTERN,
  MAX_EXPORT_LINE_BYTES,
  MAX_IMPORT_REFUSALS_REPORTED,
  MAX_INDEX_NAME_LENGTH,
  MAX_PARTITIONS,
  STATISTICS_BROADCAST_INTERVAL_MS,
} from '../../engine/constants'
export { emitEngineEvent } from '../../engine/events'
export { toError } from '../../engine/orchestration/eligibility'
export { yieldToEventLoop } from '../../engine/orchestration/turn'
export { reconstructSchemaFromMetadata } from '../../engine/recovery-schema'
export { withOpenIndex } from '../../engine/serial-index-update'
export {
  configurationPayloadOf,
  oversizedConfigurationPayloadOf,
  requireEncodedConfigurationWithinSizeLimit,
} from '../../engine/snapshot/index-configuration'
export { oneSyncChangeAtATime } from '../../engine/sync/serial'
export { holdSyncEpochChange } from '../../engine/sync-epoch'
export { emitSyncChange } from '../../engine/sync-notify'
export { prepareConfiguredSynonyms, prepareStoredSynonyms, rulesOfStoredSynonyms } from '../../engine/synonym-sets'
export { requireSurfaceFormsForPartialFields, validatePatternValueLimit } from '../../engine/validation'
export {
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  updateDocumentVectors,
} from '../../engine/vector-coordinator'
export { ErrorCodes, NarsilError } from '../../errors'
export { getLanguage } from '../../languages/registry'
export { DEFAULT_WRITE_AHEAD_QUEUE_MAX_SIZE, REBALANCE_CHUNK_SIZE } from '../../partitioning/constants'
export { mergePartitionStats } from '../../partitioning/distributed-scoring'
export { resolvePartialWordAnalysis, resolvePartitionInsertOptions } from '../../partitioning/insert-options'
export { createPartitionManager } from '../../partitioning/manager'
export { createPublicationGate } from '../../partitioning/manager/publication-gate'
export { rewriteSpillOf } from '../../partitioning/rewrite-spill-of'
export { createPartitionRouter } from '../../partitioning/router'
export { rebuildTextIndexes, textRebuildTargetOf } from '../../partitioning/text-rebuild'
export { attachedRuntimeOf } from '../../query-suggestions/attached'
export {
  MAX_HISTORY_FILE_BYTES,
  QUERY_HISTORY_ARCHIVE_PREFIX,
  QUERY_HISTORY_FOLDER,
} from '../../query-suggestions/constants'
export { historyFileOf, historyFilesOf, listHistoryFolder } from '../../query-suggestions/history-files'
export { storedStateFromWire, storedStateOf, storedStateToWire } from '../../query-suggestions/stored-state'
export { detectRuntime } from '../../runtime/detect'
export { MAX_DOCUMENT_NESTING_DEPTH } from '../../schema/constants'
export { validateEmbeddingConfig, validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
export {
  flattenSchema,
  raiseEarlierReleaseGraphSetting,
  schemaFieldsOf,
  validateDocument,
  validateDocumentStrict,
  validateSchema,
  validateTextStorage,
  validateVectorPromotion,
  validateVectorStorage,
} from '../../schema/validator'
export { messagePackUpperBoundBytes } from '../../schema/validator/document-size'
export { extractVectorFieldsFromSchema, partialFieldsOf, requireValidFieldTypes } from '../../schema/validator/schema'
export { VECTOR_PATTERN } from '../../schema/validator/shared'
export { isQuantizationMode, isStorageMode } from '../../schema/validator/vector-promotion'
export { checksumOfChunks } from '../../serialization/chunk-checksum'
export { MAX_FILE_BYTES, VALID_HNSW_METRICS } from '../../serialization/constants'
export { crc32, crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'
export { encodeDocument } from '../../serialization/document-encoding'
export {
  engineVersionParts,
  openChecksummedEnvelope,
  packChecksummedEnvelope,
  packEnvelopeWithChecksum,
  requireWithinFileLimit,
} from '../../serialization/envelope-file'
export { loadGzip } from '../../serialization/gzip-code'
export { HEADER_SIZE, hasNrslMagic, readHeader, writeHeader } from '../../serialization/header'
export { decode, decodeMulti } from '../../serialization/msgpack'
export { decodeMapWithoutFields, endOfValue } from '../../serialization/msgpack-without-fields'
export { restoreVectorFields, setNestedValue } from '../../serialization/vector-field-bytes'
export { isSyncEpoch, newSyncEpoch } from '../../sync/epoch'
export { createHNSWIndex } from '../../vector/hnsw'
export { MAX_LAYER_CAP, MAX_M, MIN_M } from '../../vector/hnsw/constants'
export { toDistance, toScore } from '../../vector/hnsw/shared'
export { nativeSearchCoreIsEnabled } from '../../vector/native/backend'
export { osqBitsOf } from '../../vector/osq'
export { osqDistance, osqEstimate } from '../../vector/osq/estimate'
export { scalarQueryProducts } from '../../vector/osq/products'
export { createOsqScratch, osqQuantize } from '../../vector/osq/quantize'
export { osqRecordBytes, readTrailer, stageQueryLevels } from '../../vector/osq/record'
export { defaultEfSearch, rescoreDepth } from '../../vector/search-depth'
export { createFixedBuffer } from '../../vector/shared-buffers/growable'
export { magnitude } from '../../vector/similarity'
export {
  assembleGraphParts,
  decodeVectorFilePayload,
  decodeVectorGraphPartPayload,
  decodeVectorGraphPayload,
  graphPartsOfEarlierPayload,
  VECTOR_FILE_MAX_VECTORS,
  VECTOR_FILE_PAYLOAD_VERSION,
} from '../../vector/vector-index/checkpoint-payload'
export { vectorsPerFile } from '../../vector/vector-index/checkpoint-plan'
export { DEFAULT_VECTOR_METRIC } from '../../vector/vector-index/constants'
export { countDead, deadBytesFor, isDead } from '../../vector/vector-index/dead-bits'
export { defaultQuantizationFor } from '../../vector/vector-index/default-quantization'
export { bytesToVectors, decodeVectorIndexParts, vectorsToBytes } from '../../vector/vector-index/payload'
export { requireBoundedUpperLists } from '../../vector/vector-index/upper-list-bound'
export { computeCodeBlockLayout } from '../../vector/vector-store/code-blocks'
export { resolveWorkerEntry } from '../../workers/entry-point'
export { createRequestId } from '../../workers/protocol'
export { loadSchemaCodeFor } from '../../workers/schema-code'
export { sha256 } from '../durability/sha256'

export function bindStorageHost(
  _host: OptionalCodeHost,
  _digest: typeof DigestCode,
  _msgpack: typeof MsgpackCode,
  _segmentCodec: typeof SegmentCodecCode,
  _segmentMerge: typeof SegmentMergeCode,
  _suggestionStore: typeof SuggestionStoreCode,
  _vectorCore: typeof VectorCoreCode,
): void {}
