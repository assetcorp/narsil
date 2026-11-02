import { scanPostingBlocks } from '../../core/partition/block-bounds'
import type { SegmentRemap } from '../../core/partition/frozen/merge-postings'
import type { FrozenTokenTableData } from '../../core/partition/frozen/token-table'
import { littleEndianBytes } from '../../serialization/keyword-segment/little-endian'
import type { PostingListView } from '../../types/internal'
import { WRITER_YIELD_INTERVAL_TOKENS } from './constants'
import { BLOCK_SUMMARY_BYTES, SMALLEST_BLOCK_POSTINGS } from './format'
import type { RemovalWriter } from './removal-sort'
import type { SectionSink } from './sink'

const NO_DELETED_DOCUMENTS = { size: 0, has: () => false }

export interface ListSinks {
  postings: SectionSink
  tokenTotals: SectionSink
  positionOffsets: SectionSink | null
  positions: SectionSink | null
}

export interface WrittenTokenColumns {
  tokenTable: FrozenTokenTableData
  postingOffsets: Uint32Array
  blockLists: Uint32Array
  blockListOffsets: Uint32Array
  blockSummaries: Uint8Array
}

interface SourceRows {
  start: number
  end: number
  docIds: ArrayLike<number>
  termFrequencies: ArrayLike<number>
  fieldNameIndices: ArrayLike<number>
  positionOffsets: ArrayLike<number> | null
  positionValues: Uint32Array | null
}

interface TokenCursor {
  input: SegmentRemap
  at: number
  bytes: Uint8Array
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength)
  for (let at = 0; at < shared; at++) {
    if (left[at] !== right[at]) return left[at] - right[at]
  }
  return left.byteLength - right.byteLength
}

function rowsOf(input: SegmentRemap, sortedIndex: number): SourceRows {
  const { segment } = input
  const { arrays, paged } = segment
  const slot = arrays.tokenTable.payloadSlot(sortedIndex)
  if (paged !== null) {
    const list = paged.listAt(slot)
    const positions = paged.positionsAt(slot)
    return {
      start: 0,
      end: list.docIds.length,
      docIds: list.docIds,
      termFrequencies: list.termFrequencies,
      fieldNameIndices: list.fieldNameIndices,
      positionOffsets: positions?.offsets ?? null,
      positionValues: positions?.values ?? null,
    }
  }
  return {
    start: arrays.postingOffsets[slot],
    end: arrays.postingOffsets[slot + 1],
    docIds: arrays.postingDocIds,
    termFrequencies: arrays.postingFrequencies,
    fieldNameIndices: arrays.postingFieldIndices,
    positionOffsets: arrays.positionOffsets,
    positionValues: arrays.positionValues,
  }
}

class GrowingBytes {
  bytes = new Uint8Array(65_536)
  length = 0

  add(chunk: Uint8Array): void {
    if (this.length + chunk.byteLength > this.bytes.byteLength) {
      const next = new Uint8Array(Math.max(this.bytes.byteLength * 2, this.length + chunk.byteLength))
      next.set(this.bytes.subarray(0, this.length))
      this.bytes = next
    }
    this.bytes.set(chunk, this.length)
    this.length += chunk.byteLength
  }

  finished(shared: boolean): Uint8Array {
    const target = new Uint8Array(shared ? new SharedArrayBuffer(this.length) : new ArrayBuffer(this.length))
    target.set(this.bytes.subarray(0, this.length))
    return target
  }
}

class GrowingUint32s {
  values = new Uint32Array(4_096)
  length = 0

  add(value: number): void {
    if (this.length === this.values.length) {
      const next = new Uint32Array(this.values.length * 2)
      next.set(this.values)
      this.values = next
    }
    this.values[this.length] = value
    this.length += 1
  }

  finished(shared: boolean): Uint32Array {
    const target = new Uint32Array(shared ? new SharedArrayBuffer(this.length * 4) : new ArrayBuffer(this.length * 4))
    target.set(this.values.subarray(0, this.length))
    return target
  }
}

class TokenRows {
  docIds = new Uint32Array(1_024)
  frequencies = new Uint16Array(1_024)
  fields = new Uint16Array(1_024)
  positionStarts = new Uint32Array(1_025)
  positions = new Uint32Array(4_096)
  count = 0
  positionCount = 0

  ensureRows(wanted: number): void {
    if (wanted <= this.docIds.length) return
    const capacity = Math.max(wanted, this.docIds.length * 2)
    const docIds = new Uint32Array(capacity)
    docIds.set(this.docIds.subarray(0, this.count))
    this.docIds = docIds
    const frequencies = new Uint16Array(capacity)
    frequencies.set(this.frequencies.subarray(0, this.count))
    this.frequencies = frequencies
    const fields = new Uint16Array(capacity)
    fields.set(this.fields.subarray(0, this.count))
    this.fields = fields
    const starts = new Uint32Array(capacity + 1)
    starts.set(this.positionStarts.subarray(0, this.count + 1))
    this.positionStarts = starts
  }

  ensurePositions(wanted: number): void {
    if (wanted <= this.positions.length) return
    const positions = new Uint32Array(Math.max(wanted, this.positions.length * 2))
    positions.set(this.positions.subarray(0, this.positionCount))
    this.positions = positions
  }

  clear(): void {
    this.count = 0
    this.positionCount = 0
  }

  appendFrom(input: SegmentRemap, rows: SourceRows): void {
    const { remap, fieldIndexRemap } = input
    this.ensureRows(this.count + rows.end - rows.start)
    for (let row = rows.start; row < rows.end; row++) {
      const target = remap[rows.docIds[row]]
      if (target < 0) continue
      const at = this.count
      this.docIds[at] = target
      this.frequencies[at] = rows.termFrequencies[row]
      this.fields[at] = fieldIndexRemap[rows.fieldNameIndices[row]]
      this.positionStarts[at] = this.positionCount
      if (rows.positionOffsets !== null && rows.positionValues !== null) {
        const from = rows.positionOffsets[row]
        const to = rows.positionOffsets[row + 1]
        this.ensurePositions(this.positionCount + to - from)
        this.positions.set(rows.positionValues.subarray(from, to), this.positionCount)
        this.positionCount += to - from
      }
      this.count += 1
    }
    this.positionStarts[this.count] = this.positionCount
  }

  isOrdered(): boolean {
    for (let at = 1; at < this.count; at++) {
      const before = this.docIds[at - 1]
      if (this.docIds[at] < before) return false
      if (this.docIds[at] === before && this.fields[at] <= this.fields[at - 1]) return false
    }
    return true
  }

  sort(): void {
    const order = Array.from({ length: this.count }, (_, at) => at)
    order.sort((left, right) => this.docIds[left] - this.docIds[right] || this.fields[left] - this.fields[right])
    const docIds = new Uint32Array(this.count)
    const frequencies = new Uint16Array(this.count)
    const fields = new Uint16Array(this.count)
    const starts = new Uint32Array(this.count + 1)
    const positions = new Uint32Array(this.positionCount)
    let cursor = 0
    for (let at = 0; at < this.count; at++) {
      const from = order[at]
      docIds[at] = this.docIds[from]
      frequencies[at] = this.frequencies[from]
      fields[at] = this.fields[from]
      starts[at] = cursor
      const held = this.positions.subarray(this.positionStarts[from], this.positionStarts[from + 1])
      positions.set(held, cursor)
      cursor += held.length
    }
    starts[this.count] = cursor
    this.docIds.set(docIds)
    this.frequencies.set(frequencies)
    this.fields.set(fields)
    this.positionStarts.set(starts)
    this.positions.set(positions)
  }

  distinctDocuments(): number {
    let documents = 0
    for (let at = 0; at < this.count; at++) {
      if (at === 0 || this.docIds[at] !== this.docIds[at - 1]) documents += 1
    }
    return documents
  }

  occurrences(): number {
    let total = 0
    for (let at = 0; at < this.count; at++) total += this.frequencies[at]
    return total
  }
}

function openCursors(inputs: readonly SegmentRemap[]): TokenCursor[] {
  const cursors: TokenCursor[] = []
  for (const input of inputs) {
    const table = input.segment.arrays.tokenTable
    if (table.size > 0) cursors.push({ input, at: 0, bytes: table.tokenBytesAt(0) })
  }
  return cursors
}

function blockSummaryBytesOf(rows: TokenRows, columns: ReadonlyArray<Uint32Array | null>): Uint8Array {
  const list: PostingListView = {
    length: rows.count,
    docIds: rows.docIds,
    termFrequencies: rows.frequencies,
    fieldNameIndices: rows.fields,
    positions: null,
    docIdSet: { size: 0 },
    deletedDocs: NO_DELETED_DOCUMENTS,
    totalTermFrequency: 0,
    structureRevision: 0,
    ordered: true,
  }
  const bounds = scanPostingBlocks(list, columns, null, 0)
  const bytes = new Uint8Array(bounds.blockCount * BLOCK_SUMMARY_BYTES)
  const view = new DataView(bytes.buffer)
  for (let block = 0; block < bounds.blockCount; block++) {
    const place = block * BLOCK_SUMMARY_BYTES
    view.setUint32(place, bounds.entryEnd[block], true)
    view.setUint16(place + 4, bounds.maxTermFrequency[block], true)
    view.setFloat64(place + 6, bounds.minFieldLength[block], true)
    view.setUint32(place + 14, bounds.maxEntriesPerDocument[block], true)
    view.setUint32(place + 18, bounds.documentCount[block], true)
  }
  return bytes
}

async function addRemovalsOf(rows: TokenRows, token: number, removals: RemovalWriter): Promise<void> {
  let at = 0
  while (at < rows.count) {
    const ordinal = rows.docIds[at]
    let occurrences = 0
    while (at < rows.count && rows.docIds[at] === ordinal) {
      occurrences += rows.frequencies[at]
      at += 1
    }
    await removals.add(ordinal, token, occurrences)
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export async function writeMergedLists(
  inputs: readonly SegmentRemap[],
  lengthColumnsByField: ReadonlyArray<Uint32Array | null>,
  sinks: ListSinks,
  removals: RemovalWriter,
  shared: boolean,
): Promise<WrittenTokenColumns> {
  const tokens = new GrowingBytes()
  const tokenOffsets = new GrowingUint32s()
  const frequencies = new GrowingUint32s()
  const postingOffsets = new GrowingUint32s()
  const blockLists = new GrowingUint32s()
  const blockListOffsets = new GrowingUint32s()
  const blockSummaries = new GrowingBytes()
  tokenOffsets.add(0)
  postingOffsets.add(0)
  blockListOffsets.add(0)
  const rows = new TokenRows()
  const total = new Float64Array(1)
  const offsetScratch = new Uint32Array(1)
  const cursors = openCursors(inputs)
  let postingsWritten = 0
  let positionsWritten = 0
  let tokensWalked = 0

  while (cursors.length > 0) {
    let smallest = cursors[0].bytes
    for (let at = 1; at < cursors.length; at++) {
      if (compareBytes(cursors[at].bytes, smallest) < 0) smallest = cursors[at].bytes
    }
    rows.clear()
    for (let at = 0; at < cursors.length; at++) {
      const cursor = cursors[at]
      if (compareBytes(cursor.bytes, smallest) !== 0) continue
      rows.appendFrom(cursor.input, rowsOf(cursor.input, cursor.at))
      cursor.at += 1
    }
    const held = smallest
    for (let at = cursors.length - 1; at >= 0; at--) {
      const cursor = cursors[at]
      if (cursor.bytes !== held && compareBytes(cursor.bytes, held) !== 0) continue
      const table = cursor.input.segment.arrays.tokenTable
      if (cursor.at >= table.size) cursors.splice(at, 1)
      else cursor.bytes = table.tokenBytesAt(cursor.at)
    }
    tokensWalked += 1
    if (tokensWalked % WRITER_YIELD_INTERVAL_TOKENS === 0) await yieldToEventLoop()
    if (rows.count === 0) continue
    if (!rows.isOrdered()) rows.sort()

    const token = frequencies.length
    tokens.add(held)
    tokenOffsets.add(tokens.length)
    frequencies.add(rows.distinctDocuments())
    await sinks.postings.write(littleEndianBytes(rows.docIds.subarray(0, rows.count)))
    await sinks.postings.write(littleEndianBytes(rows.frequencies.subarray(0, rows.count)))
    await sinks.postings.write(littleEndianBytes(rows.fields.subarray(0, rows.count)))
    total[0] = rows.occurrences()
    await sinks.tokenTotals.write(littleEndianBytes(total))
    if (sinks.positionOffsets !== null && sinks.positions !== null) {
      for (let at = 0; at < rows.count; at++) {
        offsetScratch[0] = positionsWritten + rows.positionStarts[at]
        await sinks.positionOffsets.write(littleEndianBytes(offsetScratch))
      }
      await sinks.positions.write(littleEndianBytes(rows.positions.subarray(0, rows.positionCount)))
      positionsWritten += rows.positionCount
    }
    if (rows.count > SMALLEST_BLOCK_POSTINGS) {
      blockLists.add(token)
      const summaries = blockSummaryBytesOf(rows, lengthColumnsByField)
      blockSummaries.add(summaries)
      blockListOffsets.add(blockSummaries.length / BLOCK_SUMMARY_BYTES)
    }
    await addRemovalsOf(rows, token, removals)
    postingsWritten += rows.count
    postingOffsets.add(postingsWritten)
  }

  if (sinks.positionOffsets !== null) {
    offsetScratch[0] = positionsWritten
    await sinks.positionOffsets.write(littleEndianBytes(offsetScratch))
  }
  const tokenCount = frequencies.length
  const slots = new Uint32Array(shared ? new SharedArrayBuffer(tokenCount * 4) : new ArrayBuffer(tokenCount * 4))
  for (let at = 0; at < tokenCount; at++) slots[at] = at
  return {
    tokenTable: {
      blob: tokens.finished(shared),
      offsets: tokenOffsets.finished(shared),
      payloadSlots: slots,
      documentFrequencies: frequencies.finished(shared),
    },
    postingOffsets: postingOffsets.finished(shared),
    blockLists: blockLists.finished(shared),
    blockListOffsets: blockListOffsets.finished(shared),
    blockSummaries: blockSummaries.finished(shared),
  }
}
