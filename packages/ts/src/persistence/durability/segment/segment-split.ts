import { encode } from '@msgpack/msgpack'
import type { FrozenSegment } from '../../../core/partition/frozen'
import { type SegmentSelection, selectionKeeps } from '../../../core/partition/frozen/merge'
import { ErrorCodes, NarsilError } from '../../../errors'
import { messagePackUpperBoundBytes } from '../../../schema/validator/document-size'
import { MAX_FILE_BYTES } from '../../../serialization/constants'
import { HEADER_SIZE } from '../../../serialization/header'
import { SEGMENT_FILE_FRAMING_SLACK_BYTES, SEGMENT_TOKEN_TABLE_SHARE_OF_FILE } from '../constants'

const ORDINAL_BYTES = 4
const POSTING_BYTES = 8
const VALUE_ENTRY_BYTES = 12
const GEOPOINT_ENTRY_BYTES = 20
const TOKEN_ENTRY_BYTES = 12
const STRING_HEADER_BYTES = 5

interface KeptDocuments {
  segment: FrozenSegment
  ordinals: number[]
  costs: Float64Array
}

const encoder = new TextEncoder()

function documentBytes(segment: FrozenSegment, ordinal: number): number {
  const table = segment.arrays.documentTable
  if (table !== null) return table.offsets[ordinal + 1] - table.offsets[ordinal]
  return messagePackUpperBoundBytes(segment.documentSource.docAt(ordinal))
}

function addPerEntry(costs: Float64Array, docIds: Uint32Array, bytes: number): void {
  for (let at = 0; at < docIds.length; at++) costs[docIds[at]] += bytes
}

function chargePostings(segment: FrozenSegment, costs: Float64Array, chargesTokens: boolean): void {
  const arrays = segment.arrays
  const positions = arrays.positionOffsets
  for (let p = 0; p < arrays.postingDocIds.length; p++) {
    let bytes = POSTING_BYTES
    if (positions !== null) bytes += ORDINAL_BYTES * (1 + positions[p + 1] - positions[p])
    costs[arrays.postingDocIds[p]] += bytes
  }
  if (!chargesTokens) return
  const table = arrays.tokenTable
  for (let at = 0; at < table.size; at++) {
    const slot = table.payloadSlot(at)
    const bytes = table.byteLengthAt(at) + TOKEN_ENTRY_BYTES
    for (let p = arrays.postingOffsets[slot]; p < arrays.postingOffsets[slot + 1]; p++) {
      costs[arrays.postingDocIds[p]] += bytes
    }
  }
}

function chargeColumns(segment: FrozenSegment, costs: Float64Array): void {
  const arrays = segment.arrays
  for (const column of [...arrays.numeric, ...arrays.sizes]) addPerEntry(costs, column.docIds, VALUE_ENTRY_BYTES)
  for (const column of arrays.boolean) {
    addPerEntry(costs, column.trueDocs, ORDINAL_BYTES)
    addPerEntry(costs, column.falseDocs, ORDINAL_BYTES)
  }
  for (const column of arrays.enums) addPerEntry(costs, column.docIds, ORDINAL_BYTES)
  for (const column of arrays.geo) addPerEntry(costs, column.docIds, GEOPOINT_ENTRY_BYTES)
  for (const column of arrays.pattern) {
    addPerEntry(costs, column.docIds, ORDINAL_BYTES)
    addPerEntry(costs, column.postings, ORDINAL_BYTES)
  }
}

function stringListBytes(values: readonly string[]): number {
  let bytes = STRING_HEADER_BYTES
  for (const value of values) bytes += STRING_HEADER_BYTES + encoder.encode(value).byteLength
  return bytes
}

function fixedBytesOf(segment: FrozenSegment, chargesTokens: boolean): number {
  const arrays = segment.arrays
  let bytes = stringListBytes(arrays.fieldNames)
  if (!chargesTokens) bytes += arrays.tokenTable.bytes
  for (const column of arrays.enums) bytes += stringListBytes(column.values) + column.offsets.byteLength
  for (const column of arrays.pattern) bytes += column.runs.byteLength + column.offsets.byteLength
  const surfaces = segment.sharedSnapshot?.surfaceTable ?? null
  if (surfaces !== null) bytes += surfaces.blob.byteLength + surfaces.offsets.byteLength + surfaces.counts.byteLength
  else bytes += messagePackUpperBoundBytes(arrays.readSurfaceForms())
  return bytes + segment.partialWords.bytes()
}

function keptDocumentsOf(selection: SegmentSelection, chargesTokens: boolean): KeptDocuments {
  const { segment } = selection
  const count = segment.arrays.documentCount
  const costs = new Float64Array(count)
  const perDocument = ORDINAL_BYTES * (3 + segment.arrays.fieldLengthColumns.length)
  for (let ordinal = 0; ordinal < count; ordinal++) {
    costs[ordinal] = perDocument + encoder.encode(segment.arrays.idTable.idAt(ordinal)).byteLength
  }
  chargePostings(segment, costs, chargesTokens)
  chargeColumns(segment, costs)
  const ordinals: number[] = []
  for (let ordinal = 0; ordinal < count; ordinal++) {
    if (!selectionKeeps(selection, ordinal)) continue
    costs[ordinal] += documentBytes(segment, ordinal)
    ordinals.push(ordinal)
  }
  return { segment, ordinals, costs }
}

function selectionOf(segment: FrozenSegment, ordinals: readonly number[]): SegmentSelection {
  const marked = new Uint8Array(segment.arrays.documentCount)
  for (const ordinal of ordinals) marked[ordinal] = 1
  return { segment, keep: ordinal => marked[ordinal] === 1 }
}

export interface SegmentFileGroup {
  selections: SegmentSelection[]
  documentCount: number
}

function tooLargeForOneFile(cost: number, budget: number): never {
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `A document needs up to ${Math.ceil(cost)} bytes of a segment, more than the ${Math.max(0, Math.floor(budget))} that one file leaves it`,
    { bytes: Math.ceil(cost), budget: Math.floor(budget), maximum: MAX_FILE_BYTES },
  )
}

export function splitIntoSegmentFiles(
  selections: readonly SegmentSelection[],
  schema: Record<string, string>,
  tombstones: readonly string[],
): SegmentFileGroup[] {
  let tokenBytes = 0
  for (const { segment } of selections) tokenBytes += segment.arrays.tokenTable.bytes
  const chargesTokens = tokenBytes > MAX_FILE_BYTES * SEGMENT_TOKEN_TABLE_SHARE_OF_FILE
  let fixed = HEADER_SIZE + SEGMENT_FILE_FRAMING_SLACK_BYTES + encode(schema).byteLength + encode(tombstones).byteLength
  for (const { segment } of selections) fixed += fixedBytesOf(segment, chargesTokens)
  const budget = MAX_FILE_BYTES - fixed

  const groups: SegmentFileGroup[] = []
  let current: Array<{ segment: FrozenSegment; ordinals: number[] }> = []
  let currentBytes = 0
  let currentCount = 0
  const flush = (): void => {
    if (currentCount === 0) return
    groups.push({
      selections: current.map(entry => selectionOf(entry.segment, entry.ordinals)),
      documentCount: currentCount,
    })
    current = []
    currentBytes = 0
    currentCount = 0
  }
  for (const selection of selections) {
    const kept = keptDocumentsOf(selection, chargesTokens)
    let entry: { segment: FrozenSegment; ordinals: number[] } | null = null
    for (const ordinal of kept.ordinals) {
      const cost = kept.costs[ordinal]
      if (cost > budget) tooLargeForOneFile(cost, budget)
      if (currentBytes + cost > budget) {
        flush()
        entry = null
      }
      if (entry === null) {
        entry = { segment: kept.segment, ordinals: [] }
        current.push(entry)
      }
      entry.ordinals.push(ordinal)
      currentBytes += cost
      currentCount += 1
    }
  }
  flush()
  return groups
}

export function halvesOf(group: SegmentFileGroup): [SegmentFileGroup, SegmentFileGroup] {
  const flat: Array<{ segment: FrozenSegment; ordinal: number }> = []
  for (const selection of group.selections) {
    for (let ordinal = 0; ordinal < selection.segment.arrays.documentCount; ordinal++) {
      if (!selectionKeeps(selection, ordinal)) continue
      flat.push({ segment: selection.segment, ordinal })
    }
  }
  const middle = Math.ceil(flat.length / 2)
  const groupOf = (entries: typeof flat): SegmentFileGroup => {
    const bySegment = new Map<FrozenSegment, number[]>()
    for (const { segment, ordinal } of entries) {
      let ordinals = bySegment.get(segment)
      if (ordinals === undefined) {
        ordinals = []
        bySegment.set(segment, ordinals)
      }
      ordinals.push(ordinal)
    }
    return {
      selections: [...bySegment].map(([segment, ordinals]) => selectionOf(segment, ordinals)),
      documentCount: entries.length,
    }
  }
  return [groupOf(flat.slice(0, middle)), groupOf(flat.slice(middle))]
}
