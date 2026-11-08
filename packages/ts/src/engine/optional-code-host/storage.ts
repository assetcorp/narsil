import { nodeThreadId } from '#platform/node-worker'
import { readResidentMemory } from '#platform/process-limit'
import { mergePostings } from '#platform/segment-merges'
import { countWrite, waitOutsideCountedWrite } from '#platform/turn-budget'
import { resolveIndexAnalysis } from '../../analysis/registry'
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
import { chunksOf, createByteReader } from '../../persistence/archive/byte-reader'
import { readSnapshotArchive } from '../../persistence/archive/read'
import { tarEnd, tarEntryHeaders, tarPadding } from '../../persistence/archive/tar'
import {
  graphPartKey,
  manifestKey,
  segmentKey,
  segmentsPrefix,
  snapshotBundleKey,
  vectorFileKey,
} from '../../persistence/durability/segment/layout'
import { manifestFileRefs, manifestReferencedKeys } from '../../persistence/durability/segment/manifest'
import { decodeSegmentManifest } from '../../persistence/durability/segment/manifest-decode'
import {
  invalidManifest,
  isId,
  isRecord,
  isSequenceNumber,
  isUint32,
} from '../../persistence/durability/segment/manifest-fields'
import { sha256 } from '../../persistence/durability/sha256'
import { attachedRuntimeOf } from '../../query-suggestions/attached'
import { historyFileOf, historyFilesOf, listHistoryFolder } from '../../query-suggestions/history-files'
import { storedStateFromWire, storedStateOf, storedStateToWire } from '../../query-suggestions/stored-state'
import { validateRequiredFieldsInSchema } from '../../schema/embedding-validator'
import { validateVectorPromotion } from '../../schema/validator'
import { messagePackUpperBoundBytes } from '../../schema/validator/document-size'
import { partialFieldsOf, requireValidFieldTypes } from '../../schema/validator/schema'
import { isQuantizationMode, isStorageMode } from '../../schema/validator/vector-promotion'
import { checksumOfChunks } from '../../serialization/chunk-checksum'
import { VALID_HNSW_METRICS } from '../../serialization/constants'
import { crc32, crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'
import {
  engineVersionParts,
  openChecksummedEnvelope,
  packChecksummedEnvelope,
  packEnvelopeWithChecksum,
  requireWithinFileLimit,
} from '../../serialization/envelope-file'
import { hasNrslMagic, readHeader, writeHeader } from '../../serialization/header'
import { decodeMulti } from '../../serialization/msgpack'
import {
  assembleGraphParts,
  decodeVectorFilePayload,
  decodeVectorGraphPartPayload,
  decodeVectorGraphPayload,
  graphPartsOfEarlierPayload,
} from '../../vector/vector-index/checkpoint-payload'
import { countDead, deadBytesFor } from '../../vector/vector-index/dead-bits'
import { decodeVectorIndexParts } from '../../vector/vector-index/payload'
import { configUnderAnalysis, targetOfPending } from '../analysis-change/pending-target'
import { storedArrayPositionGap } from '../array-positions'
import { ANALYSIS_CHANGE_MEMBERS, INDEX_NAME_PATTERN } from '../constants'
import { emitEngineEvent } from '../events'
import { configurationPayloadOf, requireConfigurationWithinSizeLimit } from '../snapshot/index-configuration'
import { decodeIndexConfiguration, requireConfigurationShape } from '../snapshot/index-configuration-decode'
import { oneSyncChangeAtATime } from '../sync/serial'
import { holdSyncEpochChange } from '../sync-epoch'
import { prepareConfiguredSynonyms, rulesOfStoredSynonyms } from '../synonym-sets'

export function storageHostPart() {
  return {
    ANALYSIS_CHANGE_MEMBERS,
    INDEX_NAME_PATTERN,
    TermLookup,
    VALID_HNSW_METRICS,
    assembleGraphParts,
    assemblePagedFrozenSegment,
    attachedRuntimeOf,
    checksumOfChunks,
    chunksOf,
    configUnderAnalysis,
    configurationPayloadOf,
    countDead,
    countWrite,
    crc32,
    crc32Final,
    crc32Init,
    crc32Update,
    createByteReader,
    createCompositePartition,
    createPartitionIndex,
    createPartitionManager,
    createPartitionRouter,
    createPublicationGate,
    deadBytesFor,
    decodeIndexConfiguration,
    decodeMulti,
    decodeSegmentManifest,
    decodeVectorFilePayload,
    decodeVectorGraphPartPayload,
    decodeVectorGraphPayload,
    decodeVectorIndexParts,
    emitEngineEvent,
    engineVersionParts,
    graphPartKey,
    graphPartsOfEarlierPayload,
    hasNrslMagic,
    historyFileOf,
    historyFilesOf,
    holdSyncEpochChange,
    invalidManifest,
    isId,
    isQuantizationMode,
    isRecord,
    isSequenceNumber,
    isStorageMode,
    isUint32,
    listHistoryFolder,
    manifestFileRefs,
    manifestKey,
    manifestReferencedKeys,
    mergeDocFrequencies,
    mergePartitionStats,
    mergePostings,
    messagePackUpperBoundBytes,
    nodeThreadId,
    oneSyncChangeAtATime,
    openChecksummedEnvelope,
    packChecksummedEnvelope,
    packEnvelopeWithChecksum,
    parseVectorDimension,
    partialFieldsOf,
    partitionStateOf,
    prepareConfiguredSynonyms,
    prepareFrozenPublication,
    prepareRemovalText,
    readHeader,
    readResidentMemory,
    readSnapshotArchive,
    removedSurfaceSpellings,
    requireConfigurationShape,
    requireConfigurationWithinSizeLimit,
    requireSearchActive,
    requireValidFieldTypes,
    requireWithinFileLimit,
    resolveIndexAnalysis,
    resolvePartialWordAnalysis,
    rulesOfStoredSynonyms,
    scanPostingBlocks,
    segmentKey,
    segmentsPrefix,
    sha256,
    snapshotBundleKey,
    storedArrayPositionGap,
    storedStateFromWire,
    storedStateOf,
    storedStateToWire,
    survivorDocumentsOf,
    tarEnd,
    tarEntryHeaders,
    tarPadding,
    targetOfPending,
    validateRequiredFieldsInSchema,
    validateVectorPromotion,
    vectorFileKey,
    waitOutsideCountedWrite,
    writeHeader,
    writePartitionDocument,
  }
}
