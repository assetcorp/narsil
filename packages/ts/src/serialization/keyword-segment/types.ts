import type { SegmentArraysData } from '../../core/partition/frozen/shared-snapshot'

export const KEYWORD_SEGMENT_PAYLOAD_VERSION = 1
export const KEYWORD_SEGMENT_ENVELOPE_VERSION = 4
export const MAX_SEGMENT_FIELD_NAMES = 65_536

export type KeywordSegmentArrays = SegmentArraysData

export interface KeywordSegmentContents {
  schema: Record<string, string>
  tombstones: string[]
  arrays: KeywordSegmentArrays
}
