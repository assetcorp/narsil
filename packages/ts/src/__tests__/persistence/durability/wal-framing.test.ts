import { describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { NarsilError } from '../../../errors'
import {
  frameRecord,
  readSegment,
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

const SEGMENT_MAX_BYTES = 1024

describe('WAL framing', () => {
  it('round-trips a sequence of records', () => {
    const segment = buildSegment([entry(1), entry(2), entry(3)])
    const result = readSegment(segment, SEGMENT_MAX)
    expect(result.kind).toBe('records')
    if (result.kind !== 'records') return
    expect(result.entries.map(e => e.seqNo)).toEqual([1, 2, 3])
    expect(result.truncated).toBe(false)
    expect(result.cleanByteLength).toBe(segment.length)
  })

  it('rejects a segment without the NRSW magic', () => {
    const segment = buildSegment([entry(1)])
    segment[0] = 0x00
    const result = readSegment(segment, SEGMENT_MAX)
    expect(result.kind).toBe('header-invalid')
  })

  it('rejects a segment shorter than the header', () => {
    const result = readSegment(new Uint8Array(4), SEGMENT_MAX)
    expect(result.kind).toBe('header-invalid')
  })

  it('rejects a newer WAL format version', () => {
    const segment = buildSegment([entry(1)])
    segment[4] = 2
    const result = readSegment(segment, SEGMENT_MAX)
    expect(result.kind).toBe('header-invalid')
  })

  it('truncates a torn tail with a partial length prefix', () => {
    const segment = buildSegment([entry(1), entry(2)])
    const torn = segment.slice(0, segment.length - 2)
    const result = readSegment(torn, SEGMENT_MAX)
    expect(result.kind).toBe('records')
    if (result.kind !== 'records') return
    expect(result.entries.map(e => e.seqNo)).toEqual([1])
    expect(result.truncated).toBe(true)
  })

  it('truncates a torn tail with a missing trailing checksum', () => {
    const frames = [frameRecord(entry(1)), frameRecord(entry(2))]
    const partialSecond = frames[1].slice(0, frames[1].length - 2)
    const total = SEGMENT_HEADER_SIZE + frames[0].length + partialSecond.length
    const segment = new Uint8Array(total)
    segment.set(writeSegmentHeader(), 0)
    segment.set(frames[0], SEGMENT_HEADER_SIZE)
    segment.set(partialSecond, SEGMENT_HEADER_SIZE + frames[0].length)

    const result = readSegment(segment, SEGMENT_MAX)
    expect(result.kind).toBe('records')
    if (result.kind !== 'records') return
    expect(result.entries.map(e => e.seqNo)).toEqual([1])
    expect(result.truncated).toBe(true)
    expect(result.cleanByteLength).toBe(SEGMENT_HEADER_SIZE + frames[0].length)
  })

  it('refuses a mid-log checksum hole with a valid record following', () => {
    const segment = buildSegment([entry(1), entry(2), entry(3)])
    const firstFrame = frameRecord(entry(1))
    const corruptByteOffset = SEGMENT_HEADER_SIZE + 4 + 1
    segment[corruptByteOffset] = segment[corruptByteOffset] ^ 0xff
    void firstFrame
    expect(() => readSegment(segment, SEGMENT_MAX)).toThrow(NarsilError)
    try {
      readSegment(segment, SEGMENT_MAX)
    } catch (err) {
      expect((err as NarsilError).code).toBe('PERSISTENCE_WAL_CORRUPT')
    }
  })

  it('refuses non-increasing sequence numbers with valid records following', () => {
    const segment = buildSegment([entry(1), entry(1)])
    expect(() => readSegment(segment, SEGMENT_MAX)).toThrow('strictly increasing')
  })

  it('treats an oversized record length as a torn tail', () => {
    const frames = [frameRecord(entry(1))]
    const total = SEGMENT_HEADER_SIZE + frames[0].length + 4
    const segment = new Uint8Array(total)
    segment.set(writeSegmentHeader(), 0)
    segment.set(frames[0], SEGMENT_HEADER_SIZE)
    const view = new DataView(segment.buffer)
    view.setUint32(SEGMENT_HEADER_SIZE + frames[0].length, SEGMENT_MAX_BYTES + 1, false)

    const result = readSegment(segment, SEGMENT_MAX_BYTES)
    expect(result.kind).toBe('records')
    if (result.kind !== 'records') return
    expect(result.entries.map(e => e.seqNo)).toEqual([1])
    expect(result.truncated).toBe(true)
  })

  it('reads an empty segment that contains only the header', () => {
    const header = writeSegmentHeader()
    expect(header.slice(0, 4)).toEqual(WAL_MAGIC)
    const result = readSegment(header, SEGMENT_MAX)
    expect(result.kind).toBe('records')
    if (result.kind !== 'records') return
    expect(result.entries).toEqual([])
    expect(result.truncated).toBe(false)
  })
})
