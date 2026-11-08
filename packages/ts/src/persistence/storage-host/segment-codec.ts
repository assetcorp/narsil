import type * as SegmentCodecCode from '../../core/segment-codec-leaf'

type SegmentCodecNames = Pick<
  typeof SegmentCodecCode,
  | 'DEFAULT_WRITE_AHEAD_QUEUE_MAX_SIZE'
  | 'REBALANCE_CHUNK_SIZE'
  | 'createEncodedDocumentSource'
  | 'createSharedFrozenSegment'
  | 'decodeEveryStoredDocument'
  | 'decodeMapWithoutFields'
  | 'decodeStoredDocument'
  | 'endOfValue'
  | 'rebuildTextIndexes'
  | 'reconstructSchemaFromMetadata'
  | 'rewriteSpillOf'
  | 'textRebuildTargetOf'
>

export let DEFAULT_WRITE_AHEAD_QUEUE_MAX_SIZE: SegmentCodecNames['DEFAULT_WRITE_AHEAD_QUEUE_MAX_SIZE']
export let REBALANCE_CHUNK_SIZE: SegmentCodecNames['REBALANCE_CHUNK_SIZE']
export let createEncodedDocumentSource: SegmentCodecNames['createEncodedDocumentSource']
export let createSharedFrozenSegment: SegmentCodecNames['createSharedFrozenSegment']
export let decodeEveryStoredDocument: SegmentCodecNames['decodeEveryStoredDocument']
export let decodeMapWithoutFields: SegmentCodecNames['decodeMapWithoutFields']
export let decodeStoredDocument: SegmentCodecNames['decodeStoredDocument']
export let endOfValue: SegmentCodecNames['endOfValue']
export let rebuildTextIndexes: SegmentCodecNames['rebuildTextIndexes']
export let reconstructSchemaFromMetadata: SegmentCodecNames['reconstructSchemaFromMetadata']
export let rewriteSpillOf: SegmentCodecNames['rewriteSpillOf']
export let textRebuildTargetOf: SegmentCodecNames['textRebuildTargetOf']

export function bindSegmentCodecNames(segmentCodec: SegmentCodecNames): void {
  ;({
    DEFAULT_WRITE_AHEAD_QUEUE_MAX_SIZE,
    REBALANCE_CHUNK_SIZE,
    createEncodedDocumentSource,
    createSharedFrozenSegment,
    decodeEveryStoredDocument,
    decodeMapWithoutFields,
    decodeStoredDocument,
    endOfValue,
    rebuildTextIndexes,
    reconstructSchemaFromMetadata,
    rewriteSpillOf,
    textRebuildTargetOf,
  } = segmentCodec)
}
