import type { PartialWordTableData } from '../partial-words/types'
import type { SegmentColumns } from './columns'
import type { FrozenTokenTableData } from './token-table'

export interface PagedSnapshotSection {
  name: string
  offset: number
  length: number
  pageBytes: number
  checksums: Uint8Array
}

export interface PagedSegmentSnapshot
  extends Pick<
    SegmentColumns,
    | 'documentCount'
    | 'fieldNames'
    | 'fieldLengthNames'
    | 'fieldLengthColumns'
    | 'totalFieldLengths'
    | 'postingOffsets'
    | 'numeric'
    | 'boolean'
    | 'enums'
    | 'geo'
    | 'pattern'
    | 'sizes'
  > {
  segmentId: string
  key: string
  path: string
  tracksPositions: boolean
  schema: Record<string, string>
  discardedFields: readonly string[]
  sections: PagedSnapshotSection[]
  tokenTable: FrozenTokenTableData
  blockLists: Uint32Array
  blockListOffsets: Uint32Array
  blockSummaries: Uint8Array
  documentBlocks: Uint8Array
  idSampleIds: string[]
  idSamplePositions: Uint32Array
  partialWords: PartialWordTableData | null
  tombstones: string[]
}
