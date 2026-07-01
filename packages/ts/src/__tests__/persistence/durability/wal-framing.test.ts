import { describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { NarsilError } from '../../../errors'
import {
  checkSegmentHeader,
  frameRecord,
  readDurableRegion,
  SEGMENT_HEADER_SIZE,
  WAL_MAGIC,
  writeSegmentHeader,
} from '../../../persistence/durability/wal-framing'

const SEGMENT_MAX = 67_108_864

function entry(seqNo: number, operation: 'INDEX' | 'DELETE' = 'INDEX'): ReplicationLogEntry {
  return buildEntry({
    seqNo,
    primaryTerm: 1,
    operation,
    partitionId: 0,
    indexName: 'movies',
    documentId: `doc-${seqNo}`,
    document: operation === 'INDEX' ? new Uint8Array([1, 2, 3, seqNo & 0xff]) : null,
  })
}

function buildSegment(entries: ReplicationLogEntry[]): Uint8Array {
  const frames = entries.map(frameRecord)
  const total = SEGMENT_HEADER_SIZE + frames.reduce((sum, f) => sum + f.length, 0)
  const out = new Uint8Array(total)
  out.set(writeSegmentHeader(), 0)
  let offset = SEGMENT_HEADER_SIZE
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

describe('WAL framing', () => {
  it('reads every record inside the durable region', () => {
    const segment = buildSegment([entry(1), entry(2), entry(3)])
    const entries = readDurableRegion(segment, segment.length, SEGMENT_MAX)
    expect(entries.map(e => e.seqNo)).toEqual([1, 2, 3])
  })

  it('reads only the records the durable byte length covers', () => {
    const frames = [frameRecord(entry(1)), frameRecord(entry(2))]
    const durableLength = SEGMENT_HEADER_SIZE + frames[0].length
    const total = durableLength + frames[1].length
    const segment = new Uint8Array(total)
    segment.set(writeSegmentHeader(), 0)
    segment.set(frames[0], SEGMENT_HEADER_SIZE)
    segment.set(frames[1], durableLength)

    const entries = readDurableRegion(segment, durableLength, SEGMENT_MAX)
    expect(entries.map(e => e.seqNo)).toEqual([1])
  })

  it('reports an invalid header through checkSegmentHeader', () => {
    const segment = buildSegment([entry(1)])
    segment[0] = 0x00
    const result = checkSegmentHeader(segment)
    expect(result.ok).toBe(false)
  })

  it('rejects a segment without the NRSW magic in the durable region', () => {
    const segment = buildSegment([entry(1)])
    segment[0] = 0x00
    expect(() => readDurableRegion(segment, segment.length, SEGMENT_MAX)).toThrow(NarsilError)
  })

  it('rejects a segment shorter than the header', () => {
    expect(() => readDurableRegion(new Uint8Array(4), 4, SEGMENT_MAX)).toThrow(NarsilError)
  })

  it('rejects a newer WAL format version', () => {
    const segment = buildSegment([entry(1)])
    segment[4] = 2
    const result = checkSegmentHeader(segment)
    expect(result.ok).toBe(false)
  })

  it('refuses a durable byte length that overruns the segment', () => {
    const segment = buildSegment([entry(1)])
    try {
      readDurableRegion(segment, segment.length + 1, SEGMENT_MAX)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as NarsilError).code).toBe('PERSISTENCE_WAL_CORRUPT')
    }
  })

  it('refuses a checksum hole inside the durable region', () => {
    const segment = buildSegment([entry(1), entry(2), entry(3)])
    const corruptByteOffset = SEGMENT_HEADER_SIZE + 4 + 1
    segment[corruptByteOffset] = segment[corruptByteOffset] ^ 0xff
    try {
      readDurableRegion(segment, segment.length, SEGMENT_MAX)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as NarsilError).code).toBe('PERSISTENCE_WAL_CORRUPT')
    }
  })

  it('refuses non-increasing sequence numbers inside the durable region', () => {
    const segment = buildSegment([entry(1), entry(1)])
    expect(() => readDurableRegion(segment, segment.length, SEGMENT_MAX)).toThrow('strictly increasing')
  })

  it('refuses a record that overruns the durable region', () => {
    const frames = [frameRecord(entry(1))]
    const total = SEGMENT_HEADER_SIZE + frames[0].length + 4
    const segment = new Uint8Array(total)
    segment.set(writeSegmentHeader(), 0)
    segment.set(frames[0], SEGMENT_HEADER_SIZE)
    const view = new DataView(segment.buffer)
    view.setUint32(SEGMENT_HEADER_SIZE + frames[0].length, 1024, false)

    try {
      readDurableRegion(segment, segment.length, SEGMENT_MAX)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as NarsilError).code).toBe('PERSISTENCE_WAL_CORRUPT')
    }
  })

  it('reads an empty durable region that contains only the header', () => {
    const header = writeSegmentHeader()
    expect(header.slice(0, 4)).toEqual(WAL_MAGIC)
    const entries = readDurableRegion(header, header.length, SEGMENT_MAX)
    expect(entries).toEqual([])
  })
})
