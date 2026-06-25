import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { encodeMarkerSlot, markerSlotOffset } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { replayWal } from '../../../persistence/durability/recovery'
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

function segmentBytes(entries: ReplicationLogEntry[]): Uint8Array {
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

const noopDeps = {
  manager: {
    insert: () => undefined,
    remove: () => undefined,
    has: () => false,
    getVectorIndexes: () => new Map(),
  } as never,
  vectorFieldPaths: new Set<string>(),
  vectorIndexes: new Map(),
}

describe('marker-driven WAL recovery', () => {
  let root: string
  let directory: DurableDirectory

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-marker-recovery-'))
    directory = createDurableDirectory(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('replays nothing when the commit marker is absent', async () => {
    await directory.atomicWrite(segmentName(0), segmentBytes([entry(1), entry(2)]))
    const result = await replayWal(directory, 'movies', 0, 0, noopDeps)
    expect(result.highestSeqNo).toBe(0)
  })

  it('reads only the durable region recorded by the marker', async () => {
    const full = segmentBytes([entry(1), entry(2)])
    const durableLength = SEGMENT_HEADER_SIZE + frameRecord(entry(1)).length
    await directory.atomicWrite(segmentName(0), full)
    await directory.atomicWrite('movies/wal/0/commit', markerBytes(0, durableLength, 1))

    const result = await replayWal(directory, 'movies', 0, 0, noopDeps)
    expect(result.highestSeqNo).toBe(1)
  })

  it('deletes an orphan segment newer than the marker active segment', async () => {
    await directory.atomicWrite(segmentName(0), segmentBytes([entry(1)]))
    const orphan = segmentBytes([entry(2)])
    await directory.atomicWrite(segmentName(2), orphan)
    const durableLength = SEGMENT_HEADER_SIZE + frameRecord(entry(1)).length
    await directory.atomicWrite('movies/wal/0/commit', markerBytes(0, durableLength, 1))

    await replayWal(directory, 'movies', 0, 0, noopDeps)
    const remaining = (await directory.list('movies/wal/0/')).filter(k => /\/\d{16}$/.test(k))
    expect(remaining).toEqual([segmentName(0)])
  })

  it('refuses recovery when a durable record is missing below the marker head', async () => {
    const durableLength = SEGMENT_HEADER_SIZE + frameRecord(entry(1)).length
    await directory.atomicWrite(segmentName(0), segmentBytes([entry(1)]))
    await directory.atomicWrite('movies/wal/0/commit', markerBytes(0, durableLength, 9))

    await expect(replayWal(directory, 'movies', 0, 0, noopDeps)).rejects.toMatchObject({
      code: 'PERSISTENCE_WAL_CORRUPT',
    })
  })

  it('refuses recovery when a record inside the durable region is corrupt', async () => {
    const full = segmentBytes([entry(1), entry(2)])
    const corruptOffset = SEGMENT_HEADER_SIZE + 4 + 1
    full[corruptOffset] = full[corruptOffset] ^ 0xff
    await directory.atomicWrite(segmentName(0), full)
    await directory.atomicWrite('movies/wal/0/commit', markerBytes(0, full.length, 2))

    await expect(replayWal(directory, 'movies', 0, 0, noopDeps)).rejects.toMatchObject({
      code: 'PERSISTENCE_WAL_CORRUPT',
    })
  })
})
