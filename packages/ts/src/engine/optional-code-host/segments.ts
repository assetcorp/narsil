import { LivePostings } from '#platform/live-postings'
import { bitsetIterator } from '../../core/bitset'
import { documentWithOwnBuffers, valueWithOwnBuffers } from '../../core/document-store'
import { createBooleanIndex, createEnumIndex, createNumericIndex } from '../../core/field-index'
import { createFieldMerge } from '../../core/field-merges/operations'
import { mergeFieldRegionsWith } from '../../core/field-merges/output'
import { documentsOf, embedded, numbers, uint32, words } from '../../core/field-merges/regions'
import { storedPlan } from '../../core/field-merges/stored'
import { mergeStoredFields } from '../../core/field-merges/stored-fields'
import { assembleFrozenSegment } from '../../core/partition/frozen'
import { encodeExternalIdTableData, wrapExternalIdTable } from '../../core/partition/frozen/external-ids'
import { encodeStringBlob } from '../../core/partition/frozen/string-blob'
import { decodeSurfaceTable, encodeSurfaceTable } from '../../core/partition/frozen/surface-table'
import { encodeFrozenTokenTableData, wrapFrozenTokenTable } from '../../core/partition/frozen/token-table'
import {
  buildPartialWordTableFrom,
  createSpellingTable,
  encodePartialSpellingsOf,
  partialSpellingsOfDocuments,
} from '../../core/partition/partial-words/registry'
import { sameFields } from '../../core/partition/partial-words/spellings'
import { prepareDocumentText } from '../../core/partition/prepared-text'
import { encodeFieldIndexes } from '../../core/partition/segment-field-indexes'
import { getNestedValue } from '../../core/partition/utils'
import { rebuildSizeIndexes, recordValueSize } from '../../core/partition/value-sizes'
import { patternIndexOf } from '../../core/pattern-index/host'
import { requirePatternSearch } from '../../core/pattern-index/registry'
import { cloneProjected, projectIncludedPaths, readProjectedPath } from '../../core/projection'
import { mergeKeywordSources, mergeTextAt } from '../../core/segment-merges/output'
import { GrowingSegment } from '../../core/segment-writes/growing'
import { createSurfaceRegistry } from '../../core/surface-registry'
import { createLoadedGeoIndex } from '../../geo/geo-code'
import { raiseEarlierReleaseGraphSetting } from '../../schema/validator'
import { isWordIndexedBase } from '../../schema/validator/field-type'
import { PROTOTYPE_POLLUTION_KEYS } from '../../schema/validator/shared'
import {
  DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
  DOCUMENT_REPLY_ENVELOPE_DEPTH,
  MAX_DOCUMENT_ENCODING_DEPTH,
} from '../../serialization/constants'

export function segmentsHostPart() {
  return {
    DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
    DOCUMENT_REPLY_ENVELOPE_DEPTH,
    GrowingSegment,
    LivePostings,
    MAX_DOCUMENT_ENCODING_DEPTH,
    PROTOTYPE_POLLUTION_KEYS,
    assembleFrozenSegment,
    bitsetIterator,
    buildPartialWordTableFrom,
    cloneProjected,
    createBooleanIndex,
    createEnumIndex,
    createFieldMerge,
    createLoadedGeoIndex,
    createNumericIndex,
    createSpellingTable,
    createSurfaceRegistry,
    decodeSurfaceTable,
    documentWithOwnBuffers,
    documentsOf,
    embedded,
    encodeExternalIdTableData,
    encodeFieldIndexes,
    encodeFrozenTokenTableData,
    encodePartialSpellingsOf,
    encodeStringBlob,
    encodeSurfaceTable,
    getNestedValue,
    isWordIndexedBase,
    mergeFieldRegionsWith,
    mergeKeywordSources,
    mergeStoredFields,
    mergeTextAt,
    numbers,
    partialSpellingsOfDocuments,
    patternIndexOf,
    prepareDocumentText,
    projectIncludedPaths,
    raiseEarlierReleaseGraphSetting,
    readProjectedPath,
    rebuildSizeIndexes,
    recordValueSize,
    requirePatternSearch,
    sameFields,
    storedPlan,
    uint32,
    valueWithOwnBuffers,
    words,
    wrapExternalIdTable,
    wrapFrozenTokenTable,
  }
}
