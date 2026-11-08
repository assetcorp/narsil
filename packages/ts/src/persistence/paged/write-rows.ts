import { ErrorCodes, mergePostings, NarsilError } from '#platform/storage-host'
import type { SegmentRemap } from '../../core/partition/frozen/merge-postings'
import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { POSTING_WRITE_POSITIONS, POSTING_WRITE_ROWS } from './constants'

function sourceRows(input: SegmentRemap, sortedIndex: number) {
  const { arrays, paged } = input.segment
  const slot = arrays.tokenTable.payloadSlot(sortedIndex)
  if (paged !== null) {
    const list = paged.listAt(slot)
    const positions = paged.positionsAt(slot)
    return {
      postingDocuments: list.docIds,
      postingFrequencies: list.termFrequencies,
      postingFields: list.fieldNameIndices,
      positionOffsets: positions?.offsets ?? null,
      positionValues: positions?.values ?? null,
    }
  }
  const start = arrays.postingOffsets[slot]
  const end = arrays.postingOffsets[slot + 1]
  return {
    postingDocuments: arrays.postingDocIds.subarray(start, end),
    postingFrequencies: arrays.postingFrequencies.subarray(start, end),
    postingFields: arrays.postingFieldIndices.subarray(start, end),
    positionOffsets: arrays.positionOffsets?.subarray(start, end + 1) ?? null,
    positionValues: arrays.positionValues,
  }
}

export class TokenRows {
  docIds = new Uint32Array(POSTING_WRITE_ROWS)
  frequencies = new Uint16Array(POSTING_WRITE_ROWS)
  fields = new Uint16Array(POSTING_WRITE_ROWS)
  positionStarts = new Uint32Array(POSTING_WRITE_ROWS + 1)
  positions = new Uint32Array(POSTING_WRITE_POSITIONS)
  count = 0
  positionCount = 0
  private readonly totals = new Float64Array(2)
  private readonly inputs: NativeKeywordMergeInput[] = []
  private readonly sources = new Map<SegmentRemap, NativeKeywordMergeInput>()
  private rowCapacity = 0
  private positionCapacity = 0

  constructor(
    private readonly documentCount: number,
    private readonly fieldCount: number,
  ) {}

  clear(): void {
    this.inputs.length = 0
    this.rowCapacity = 0
    this.positionCapacity = 0
  }

  appendFrom(input: SegmentRemap, sortedIndex: number): void {
    let source = this.sources.get(input)
    const rows = sourceRows(input, sortedIndex)
    if (source === undefined) {
      source = {
        ...rows,
        terms: { text: new Uint8Array(), offsets: new Uint32Array(1), counts: new Uint32Array() },
        payloadSlots: new Uint32Array(),
        postingOffsets: new Uint32Array(1),
        mapping: new Uint32Array(input.remap.buffer, input.remap.byteOffset, input.remap.length),
        fieldMapping: input.fieldIndexRemap,
        fieldLengths: input.segment.arrays.fieldNames.map(() => null),
        documentCount: input.segment.arrays.documentCount,
        surfaces: null,
        spellings: null,
      }
      this.sources.set(input, source)
    } else Object.assign(source, rows)
    this.inputs.push(source)
    this.rowCapacity += rows.postingDocuments.length
    if (rows.positionOffsets !== null) {
      this.positionCapacity += rows.positionOffsets[rows.postingDocuments.length] - rows.positionOffsets[0]
    }
  }

  finish(): void {
    if (this.rowCapacity > this.docIds.length) {
      const capacity = Math.max(this.rowCapacity, this.docIds.length * 2)
      this.docIds = new Uint32Array(capacity)
      this.frequencies = new Uint16Array(capacity)
      this.fields = new Uint16Array(capacity)
      this.positionStarts = new Uint32Array(capacity + 1)
    }
    if (this.positionCapacity > this.positions.length) {
      this.positions = new Uint32Array(Math.max(this.positionCapacity, this.positions.length * 2))
    }
    const count = mergePostings(this.inputs, this.documentCount, this.fieldCount, {
      documents: this.docIds,
      frequencies: this.frequencies,
      fields: this.fields,
      positionOffsets: this.positionStarts,
      positions: this.positions,
      totals: this.totals,
    })
    if (count < 0) {
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The paged posting list refused a merge', {
        status: -count,
      })
    }
    this.count = count
    this.positionCount = this.positionStarts[count]
  }

  distinctDocuments(): number {
    return this.totals[0]
  }

  occurrences(): number {
    return this.totals[1]
  }
}
