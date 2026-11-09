import type { OptionalCodeHost } from '../engine/optional-code-host'
import type * as MsgpackCode from '../serialization/msgpack-leaf'
import type * as SegmentCodecCode from './segment-codec-leaf'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ErrorCodes'
  | 'GrowingSegment'
  | 'LivePostings'
  | 'MergeRegions'
  | 'NarsilError'
  | 'SegmentRefusal'
  | 'bitsetIterator'
  | 'buildPartialWordTableFrom'
  | 'captureInputs'
  | 'createBooleanIndex'
  | 'createEnumIndex'
  | 'createFieldMerge'
  | 'createLoadedGeoIndex'
  | 'createNumericIndex'
  | 'createSpellingTable'
  | 'createSurfaceRegistry'
  | 'documentsOf'
  | 'embedded'
  | 'encodeExternalIdTableData'
  | 'encodeFieldIndexes'
  | 'encodeFrozenTokenTableData'
  | 'encodePartialSpellingsOf'
  | 'encodeStringBlob'
  | 'encodeSurfaceTable'
  | 'generateId'
  | 'getFlatSchema'
  | 'getNestedValue'
  | 'isWordIndexedBase'
  | 'mergeFieldRegionsWith'
  | 'mergeKeywordSources'
  | 'mergeStoredFields'
  | 'mergeTextAt'
  | 'numbers'
  | 'partialSpellingsOfDocuments'
  | 'patternIndexOf'
  | 'prepareDocumentText'
  | 'rebuildSizeIndexes'
  | 'recordValueSize'
  | 'regionLength'
  | 'regionsOverlap'
  | 'requirePatternSearch'
  | 'requireRoom'
  | 'requireSegment'
  | 'sameFields'
  | 'schemaFieldsOf'
  | 'storedPlan'
  | 'storedText'
  | 'typedRegion'
  | 'uint32'
  | 'validateDocument'
  | 'validateDocumentStrict'
  | 'words'
  | 'wrapFrozenTokenTable'
>
type MsgpackNames = Pick<typeof MsgpackCode, 'encodeDocument'>
type SegmentCodecNames = Pick<
  typeof SegmentCodecCode,
  'encodeDocumentTableData' | 'storedDocumentsOf' | 'topLevelMapKeys'
>

export let ErrorCodes: EngineNames['ErrorCodes']
export let GrowingSegment: EngineNames['GrowingSegment']
export type GrowingSegment = InstanceType<EngineNames['GrowingSegment']>
export let LivePostings: EngineNames['LivePostings']
export type LivePostings = InstanceType<EngineNames['LivePostings']>
export let MergeRegions: EngineNames['MergeRegions']
export type MergeRegions = InstanceType<EngineNames['MergeRegions']>
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let SegmentRefusal: EngineNames['SegmentRefusal']
export type SegmentRefusal = InstanceType<EngineNames['SegmentRefusal']>
export let bitsetIterator: EngineNames['bitsetIterator']
export let buildPartialWordTableFrom: EngineNames['buildPartialWordTableFrom']
export let captureInputs: EngineNames['captureInputs']
export let createBooleanIndex: EngineNames['createBooleanIndex']
export let createEnumIndex: EngineNames['createEnumIndex']
export let createFieldMerge: EngineNames['createFieldMerge']
export let createLoadedGeoIndex: EngineNames['createLoadedGeoIndex']
export let createNumericIndex: EngineNames['createNumericIndex']
export let createSpellingTable: EngineNames['createSpellingTable']
export let createSurfaceRegistry: EngineNames['createSurfaceRegistry']
export let documentsOf: EngineNames['documentsOf']
export let embedded: EngineNames['embedded']
export let encodeExternalIdTableData: EngineNames['encodeExternalIdTableData']
export let encodeFieldIndexes: EngineNames['encodeFieldIndexes']
export let encodeFrozenTokenTableData: EngineNames['encodeFrozenTokenTableData']
export let encodePartialSpellingsOf: EngineNames['encodePartialSpellingsOf']
export let encodeStringBlob: EngineNames['encodeStringBlob']
export let encodeSurfaceTable: EngineNames['encodeSurfaceTable']
export let generateId: EngineNames['generateId']
export let getFlatSchema: EngineNames['getFlatSchema']
export let getNestedValue: EngineNames['getNestedValue']
export let isWordIndexedBase: EngineNames['isWordIndexedBase']
export let mergeFieldRegionsWith: EngineNames['mergeFieldRegionsWith']
export let mergeKeywordSources: EngineNames['mergeKeywordSources']
export let mergeStoredFields: EngineNames['mergeStoredFields']
export let mergeTextAt: EngineNames['mergeTextAt']
export let numbers: EngineNames['numbers']
export let partialSpellingsOfDocuments: EngineNames['partialSpellingsOfDocuments']
export let patternIndexOf: EngineNames['patternIndexOf']
export let prepareDocumentText: EngineNames['prepareDocumentText']
export let rebuildSizeIndexes: EngineNames['rebuildSizeIndexes']
export let recordValueSize: EngineNames['recordValueSize']
export let regionLength: EngineNames['regionLength']
export let regionsOverlap: EngineNames['regionsOverlap']
export let requirePatternSearch: EngineNames['requirePatternSearch']
export let requireRoom: EngineNames['requireRoom']
export let requireSegment: EngineNames['requireSegment']
export let sameFields: EngineNames['sameFields']
export let schemaFieldsOf: EngineNames['schemaFieldsOf']
export let storedPlan: EngineNames['storedPlan']
export let storedText: EngineNames['storedText']
export let typedRegion: EngineNames['typedRegion']
export let uint32: EngineNames['uint32']
export let validateDocument: EngineNames['validateDocument']
export let validateDocumentStrict: EngineNames['validateDocumentStrict']
export let words: EngineNames['words']
export let wrapFrozenTokenTable: EngineNames['wrapFrozenTokenTable']
export let encodeDocument: MsgpackNames['encodeDocument']
export let encodeDocumentTableData: SegmentCodecNames['encodeDocumentTableData']
export let storedDocumentsOf: SegmentCodecNames['storedDocumentsOf']
export let topLevelMapKeys: SegmentCodecNames['topLevelMapKeys']

export function bindSegmentMergeHost(host: EngineNames, msgpack: MsgpackNames, segmentCodec: SegmentCodecNames): void {
  ;({
    ErrorCodes,
    GrowingSegment,
    LivePostings,
    MergeRegions,
    NarsilError,
    SegmentRefusal,
    bitsetIterator,
    buildPartialWordTableFrom,
    captureInputs,
    createBooleanIndex,
    createEnumIndex,
    createFieldMerge,
    createLoadedGeoIndex,
    createNumericIndex,
    createSpellingTable,
    createSurfaceRegistry,
    documentsOf,
    embedded,
    encodeExternalIdTableData,
    encodeFieldIndexes,
    encodeFrozenTokenTableData,
    encodePartialSpellingsOf,
    encodeStringBlob,
    encodeSurfaceTable,
    generateId,
    getFlatSchema,
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
    rebuildSizeIndexes,
    recordValueSize,
    regionLength,
    regionsOverlap,
    requirePatternSearch,
    requireRoom,
    requireSegment,
    sameFields,
    schemaFieldsOf,
    storedPlan,
    storedText,
    typedRegion,
    uint32,
    validateDocument,
    validateDocumentStrict,
    words,
    wrapFrozenTokenTable,
  } = host)
  ;({ encodeDocument } = msgpack)
  ;({ encodeDocumentTableData, storedDocumentsOf, topLevelMapKeys } = segmentCodec)
}
