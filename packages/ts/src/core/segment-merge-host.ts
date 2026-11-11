import type { OptionalCodeHost } from '../engine/optional-code-host'
import type * as MsgpackCode from '../serialization/msgpack-leaf'
import type * as SegmentCodecCode from './segment-codec-leaf'

export { LivePostings } from '#platform/live-postings'
export { ErrorCodes, NarsilError } from '../errors'
export { createLoadedGeoIndex } from '../geo/geo-code'
export { schemaFieldsOf } from '../schema/validator'
export { validateDocument, validateDocumentStrict } from '../schema/validator/document'
export { isWordIndexedBase } from '../schema/validator/field-type'
export { encodeDocument } from '../serialization/document-encoding'
export { topLevelMapKeys } from '../serialization/msgpack-without-fields'
export { bitsetIterator } from './bitset'
export { createBooleanIndex, createEnumIndex, createNumericIndex } from './field-index'
export { createFieldMerge } from './field-merges/operations'
export { mergeFieldRegionsWith } from './field-merges/output'
export { documentsOf, embedded, numbers, uint32, words } from './field-merges/regions'
export { storedPlan } from './field-merges/stored'
export { mergeStoredFields } from './field-merges/stored-fields'
export { generateId } from './id-generator'
export { encodeDocumentTableData, storedDocumentsOf } from './partition/frozen/document-source'
export { encodeExternalIdTableData } from './partition/frozen/external-ids'
export { encodeStringBlob } from './partition/frozen/string-blob'
export { encodeSurfaceTable } from './partition/frozen/surface-table'
export { encodeFrozenTokenTableData, wrapFrozenTokenTable } from './partition/frozen/token-table'
export {
  buildPartialWordTableFrom,
  createSpellingTable,
  encodePartialSpellingsOf,
  partialSpellingsOfDocuments,
} from './partition/partial-words/registry'
export { sameFields } from './partition/partial-words/spellings'
export { prepareDocumentText } from './partition/prepared-text'
export { encodeFieldIndexes } from './partition/segment-field-indexes'
export { getFlatSchema, getNestedValue } from './partition/utils'
export { rebuildSizeIndexes, recordValueSize } from './partition/value-sizes'
export { patternIndexOf } from './pattern-index/host'
export { requirePatternSearch } from './pattern-index/registry'
export { regionsOverlap } from './regions'
export { mergeKeywordSources, mergeTextAt } from './segment-merges/output'
export { captureInputs, MergeRegions } from './segment-merges/regions'
export { GrowingSegment } from './segment-writes/growing'
export { requireRoom, requireSegment, SegmentRefusal } from './segment-writes/status'
export { regionLength, typedRegion } from './stored-values/regions'
export { storedText } from './stored-values/text'
export { createSurfaceRegistry } from './surface-registry'

export function bindSegmentMergeHost(
  _host: OptionalCodeHost,
  _msgpack: typeof MsgpackCode,
  _segmentCodec: typeof SegmentCodecCode,
): void {}
