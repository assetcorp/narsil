import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { truncateCoveredSegments } from '../../../persistence/durability/checkpoint'
import { encodeMarkerSlot, markerSlotOffset } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { frameRecord, SEGMENT_HEADER_SIZE, writeSegmentHeader } from '../../../persistence/durability/wal-framing'

function entry(seqNo: number): ReplicationLogEntry {
  return buildEntry({
    seqNo,
    primaryTerm: 1,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'movies',
    documentId: `doc-${seqNo}`,
    document: new Uint8Array([seqNo & 0xff]),
  })
}

function segmentBytes(seqNos: number[]): Uint8Array {
  const frames = seqNos.map(seqNo => frameRecord(entry(seqNo)))
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

function markerBytes(activeSegmentSeqNo: number, durableByteLength: number, highestDurableSeqNo: number): Uint8Array {
  const file = new Uint8Array(72)
  file.set(
    encodeMarkerSlot({ writeSeq: 1, activeSegmentSeqNo, durableByteLength, highestDurableSeqNo }),
    markerSlotOffset(0),
  )
  return file
}

function segmentName(startSeqNo: number): string {
  return `movies/wal/0/${startSeqNo.toString().padStart(16, '0')}`
}

describe('checkpoint truncation honours the commit marker active segment', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-ckpt-active-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('never deletes the segment named active by the commit marker', async () => {
    const directory = createDurableDirectory(root)

    const sealed = segmentBytes([1, 2, 3])
    await directory.atomicWrite(segmentName(1), sealed)
    await directory.atomicWrite(segmentName(5), segmentBytes([5, 6, 7]))
    await directory.atomicWrite('movies/wal/0/commit', markerBytes(1, sealed.length, 3))

    await truncateCoveredSegments(directory, 'movies', [{ partitionId: 0, lastSeqNo: 10, primaryTerm: 1 }])

    const remaining = (await directory.list('movies/wal/0/')).filter(k => /\/\d{16}$/.test(k))
    expect(remaining).toContain(segmentName(1))
  })
})
