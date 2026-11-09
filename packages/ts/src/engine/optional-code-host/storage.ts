import { nodeThreadId } from '#platform/node-worker'
import { readResidentMemory } from '#platform/process-limit'
import { countWrite, waitOutsideCountedWrite } from '#platform/turn-budget'
import { resolveIndexAnalysis } from '../../analysis/registry'
import { ARRAY_POSITION_GAP, DEFAULT_BM25_B, DEFAULT_BM25_K1 } from '../../core/constants'
import { prepareFrozenPublication } from '../../core/frozen-writes/publication'
import { createPartitionIndex, partitionStateOf } from '../../core/partition'
import { scanPostingBlocks } from '../../core/partition/block-bounds'
import { createCompositePartition } from '../../core/partition/composite'
import { survivorDocumentsOf } from '../../core/partition/composite/compaction'
import { mergeDocFrequencies } from '../../core/partition/composite/stats'
import { assemblePagedFrozenSegment } from '../../core/partition/frozen'
import { prepareRemovalText, removedSurfaceSpellings } from '../../core/partition/frozen/removal-text'
import { writePartitionDocument } from '../../core/partition/rollover'
import { parseVectorDimension } from '../../core/partition/utils'
import { requireSearchActive } from '../../core/search-stop'
import { TermLookup } from '../../core/term-table/lookup'
import { mergePartitionStats } from '../../partitioning/distributed-scoring'
import { resolvePartialWordAnalysis } from '../../partitioning/insert-options'
import { createPartitionManager } from '../../partitioning/manager'
import { createPublicationGate } from '../../partitioning/manager/publication-gate'
import { createPartitionRouter } from '../../partitioning/router'
import { MAX_DOCUMENT_NESTING_DEPTH } from '../../schema/constants'
import { validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
import { validateVectorPromotion } from '../../schema/validator'
import { messagePackUpperBoundBytes } from '../../schema/validator/document-size'
import { partialFieldsOf, requireValidFieldTypes } from '../../schema/validator/schema'
import { isQuantizationMode, isStorageMode } from '../../schema/validator/vector-promotion'
import { VALID_HNSW_METRICS } from '../../serialization/constants'
import { storedArrayPositionGap } from '../array-positions'
import {
  ANALYSIS_CHANGE_MEMBERS,
  ANALYSIS_HOLD_APPLY_INTERVAL_MS,
  EXPORT_CHUNK_BYTES,
  FOREIGN_STATS_TTL_MS,
  IMPORT_BATCH_DOCUMENTS,
  INDEX_NAME_PATTERN,
  MAX_EXPORT_LINE_BYTES,
  MAX_IMPORT_REFUSALS_REPORTED,
  MAX_INDEX_NAME_LENGTH,
  STATISTICS_BROADCAST_INTERVAL_MS,
} from '../constants'
import { emitEngineEvent } from '../events'
import {
  configurationPayloadOf,
  oversizedConfigurationPayloadOf,
  requireEncodedConfigurationWithinSizeLimit,
} from '../snapshot/index-configuration'
import { holdSyncEpochChange } from '../sync-epoch'
import { prepareConfiguredSynonyms, rulesOfStoredSynonyms } from '../synonym-sets'

export function storageHostPart() {
  return {
    ANALYSIS_CHANGE_MEMBERS,
    ANALYSIS_HOLD_APPLY_INTERVAL_MS,
    ARRAY_POSITION_GAP,
    DEFAULT_BM25_B,
    DEFAULT_BM25_K1,
    EXPORT_CHUNK_BYTES,
    FOREIGN_STATS_TTL_MS,
    IMPORT_BATCH_DOCUMENTS,
    INDEX_NAME_PATTERN,
    MAX_DOCUMENT_NESTING_DEPTH,
    MAX_EXPORT_LINE_BYTES,
    MAX_IMPORT_REFUSALS_REPORTED,
    MAX_INDEX_NAME_LENGTH,
    STATISTICS_BROADCAST_INTERVAL_MS,
    TermLookup,
    VALID_HNSW_METRICS,
    assemblePagedFrozenSegment,
    configurationPayloadOf,
    countWrite,
    createCompositePartition,
    createPartitionIndex,
    createPartitionManager,
    createPartitionRouter,
    createPublicationGate,
    emitEngineEvent,
    holdSyncEpochChange,
    isQuantizationMode,
    isStorageMode,
    mergeDocFrequencies,
    mergePartitionStats,
    messagePackUpperBoundBytes,
    nodeThreadId,
    oversizedConfigurationPayloadOf,
    parseVectorDimension,
    partialFieldsOf,
    partitionStateOf,
    prepareConfiguredSynonyms,
    prepareFrozenPublication,
    prepareRemovalText,
    readResidentMemory,
    removedSurfaceSpellings,
    requireEncodedConfigurationWithinSizeLimit,
    requireSearchActive,
    requireValidFieldTypes,
    resolveIndexAnalysis,
    resolvePartialWordAnalysis,
    rulesOfStoredSynonyms,
    scanPostingBlocks,
    storedArrayPositionGap,
    survivorDocumentsOf,
    validateRequiredFieldsInSchema,
    validateVectorPromotion,
    waitOutsideCountedWrite,
    writePartitionDocument,
  }
}
