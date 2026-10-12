import { mergeSegmentContents, type SegmentSelection, selectionKeeps } from '../../../core/partition/frozen/merge'
import { segmentArraysOf } from '../../../core/partition/frozen/shared-snapshot'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import { ErrorCodes, NarsilError } from '../../../errors'
import { MAX_FILE_BYTES } from '../../../serialization/constants'
import { packChecksummedEnvelope } from '../../../serialization/envelope-file'
import { HEADER_SIZE } from '../../../serialization/header'
import { encodeKeywordSegment } from '../../../serialization/keyword-segment/encode'
import {
  KEYWORD_SEGMENT_ENVELOPE_VERSION,
  type KeywordSegmentContents,
} from '../../../serialization/keyword-segment/types'
import { segmentKey } from './layout'
import { MAX_SEGMENTS_PER_PARTITION, type SegmentRef } from './manifest'
import { halvesOf, type SegmentFileGroup, splitIntoSegmentFiles } from './segment-split'
import type { CheckpointStore } from './store'

export interface SegmentWriteRequest {
  store: CheckpointStore
  indexName: string
  partitionId: number
  nextSegmentId: number
  schema: Record<string, string>
  selections: readonly SegmentSelection[]
  tombstones: readonly string[]
  mergesIntoOneFile?: boolean
}

export interface SegmentsWritten {
  segments: SegmentRef[]
  nextSegmentId: number
}

function emptyPayload(): SegmentPayload {
  return {
    documentCount: 0,
    docIds: [],
    fieldNames: [],
    tokens: [],
    postingOffsets: new Uint32Array(1),
    postingDocIds: new Uint32Array(0),
    postingFrequencies: new Uint16Array(0),
    postingFieldIndices: new Uint16Array(0),
    positionOffsets: null,
    positionValues: null,
    fieldLengthNames: [],
    fieldLengthColumns: [],
    totalFieldLengths: {},
    docFrequencies: {},
    surfaceForms: null,
    numeric: [],
    boolean: [],
    enums: [],
    geo: [],
    pattern: [],
    sizes: [],
  }
}

function contentsOfGroup(
  group: SegmentFileGroup | null,
  schema: Record<string, string>,
  tombstones: string[],
): KeywordSegmentContents {
  if (group === null) {
    return {
      schema,
      tombstones,
      arrays: segmentArraysOf(emptyPayload(), { blob: new Uint8Array(0), offsets: new Uint32Array(1) }),
    }
  }
  const merged = mergeSegmentContents(group.selections)
  return { schema, tombstones, arrays: segmentArraysOf(merged.payload, merged.documents) }
}

interface WriteState {
  request: SegmentWriteRequest
  segments: SegmentRef[]
  nextSegmentId: number
  tombstonesWritten: boolean
}

function requireRoomForAnotherSegment(state: WriteState): void {
  if (state.segments.length < MAX_SEGMENTS_PER_PARTITION) return
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `Partition ${state.request.partitionId} would hold more than ${MAX_SEGMENTS_PER_PARTITION} segments`,
    { partitionId: state.request.partitionId, maximum: MAX_SEGMENTS_PER_PARTITION },
  )
}

async function writeGroup(state: WriteState, group: SegmentFileGroup | null): Promise<void> {
  const { request } = state
  const tombstones = state.tombstonesWritten ? [] : [...request.tombstones]
  const contents = contentsOfGroup(group, request.schema, tombstones)
  const encoded = encodeKeywordSegment(contents)
  if (HEADER_SIZE + encoded.byteLength > MAX_FILE_BYTES && group !== null && group.documentCount > 1) {
    const [first, second] = halvesOf(group)
    await writeGroup(state, first)
    await writeGroup(state, second)
    return
  }
  requireRoomForAnotherSegment(state)
  const id = state.nextSegmentId
  const key = segmentKey(request.indexName, request.partitionId, id)
  const packed = await packChecksummedEnvelope(encoded.chunks, KEYWORD_SEGMENT_ENVELOPE_VERSION, `segment "${key}"`)
  await request.store.write(key, packed.chunks)
  state.segments.push({
    id,
    key,
    bytes: packed.byteLength,
    checksum: packed.checksum,
    docCount: contents.arrays.documentCount,
    tombstoneCount: tombstones.length,
  })
  state.nextSegmentId = id + 1
  state.tombstonesWritten = true
}

function keptDocumentCount(selections: readonly SegmentSelection[]): number {
  let count = 0
  for (const selection of selections) {
    for (let ordinal = 0; ordinal < selection.segment.arrays.documentCount; ordinal++) {
      if (selectionKeeps(selection, ordinal)) count += 1
    }
  }
  return count
}

export async function writeSegmentsOf(request: SegmentWriteRequest): Promise<SegmentsWritten> {
  const state: WriteState = { request, segments: [], nextSegmentId: request.nextSegmentId, tombstonesWritten: false }
  const groups =
    request.mergesIntoOneFile === true
      ? [{ selections: [...request.selections], documentCount: keptDocumentCount(request.selections) }]
      : splitIntoSegmentFiles(request.selections, request.schema, request.tombstones)
  for (const group of groups) {
    if (group.documentCount > 0) await writeGroup(state, group)
  }
  if (!state.tombstonesWritten && request.tombstones.length > 0) await writeGroup(state, null)
  return { segments: state.segments, nextSegmentId: state.nextSegmentId }
}
