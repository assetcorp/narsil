import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { readCommitMarker } from '../../../persistence/durability/commit-marker'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readDurableRegion } from '../../../persistence/durability/wal-framing'
import { createWalWriter, parseSegmentStartSeqNo } from '../../../persistence/durability/wal-writer'

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

function segmentKeys(keys: string[]): string[] {
  return keys.filter(k => /\/\d{16}$/.test(k)).sort()
}

async function readAllEntries(directory: DurableDirectory): Promise<ReplicationLogEntry[]> {
  const markerBytes = await directory.read('movies/wal/0/commit')
  const marker = markerBytes === null ? null : readCommitMarker(markerBytes)
  if (marker === null) {
    return []
  }
  const keys = segmentKeys(await directory.list('movies/wal/0/'))
  const entries: ReplicationLogEntry[] = []
  for (const key of keys) {
    const bytes = await directory.read(key)
    if (bytes === null) {
      continue
    }
    const tail = Number.parseInt(key.slice(key.lastIndexOf('/') + 1), 10)
    const durableLength = tail < marker.state.activeSegmentSeqNo ? bytes.length : marker.state.durableByteLength
    entries.push(...readDurableRegion(bytes, durableLength, 67_108_864))
  }
  return entries
}

describe('WAL writer', () => {
  let root: string
  let directory: DurableDirectory

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-wal-'))
    directory = createDurableDirectory(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes a segment header and durable records readable on recovery', async () => {
    const writer = createWalWriter(directory, { indexName: 'movies', partitionId: 0 })
    await writer.appendDurable(entry(1))
    await writer.appendDurable(entry(2))
    await writer.close()

    const entries = await readAllEntries(directory)
    expect(entries.map(e => e.seqNo)).toEqual([1, 2])
    expect(writer.activeSegmentKey).toBeNull()
  })

  it('records the durable head in the commit marker', async () => {
    const writer = createWalWriter(directory, { indexName: 'movies', partitionId: 0 })
    await writer.appendDurable(entry(1))
    await writer.appendDurable(entry(2))
    await writer.close()

    const markerBytes = await directory.read('movies/wal/0/commit')
    expect(markerBytes).not.toBeNull()
    if (markerBytes === null) return
    const marker = readCommitMarker(markerBytes)
    expect(marker?.state.highestDurableSeqNo).toBe(2)
  })

  it('batches a fsync across an append followed by commit', async () => {
    const writer = createWalWriter(directory, { indexName: 'movies', partitionId: 0 })
    await writer.append(entry(1))
    await writer.append(entry(2))
    await writer.commit()
    await writer.close()

    const entries = await readAllEntries(directory)
    expect(entries.map(e => e.seqNo)).toEqual([1, 2])
  })

  it('rolls to a new segment when the active segment exceeds the size limit', async () => {
    const writer = createWalWriter(directory, { indexName: 'movies', partitionId: 0, segmentMaxBytes: 32 })
    await writer.appendDurable(entry(1))
    await writer.appendDurable(entry(2))
    await writer.appendDurable(entry(3))
    await writer.close()

    const keys = segmentKeys(await directory.list('movies/wal/0/'))
    expect(keys.length).toBeGreaterThan(1)
    const entries = await readAllEntries(directory)
    expect(entries.map(e => e.seqNo)).toEqual([1, 2, 3])
  })

  it('reopens an existing segment without rewriting its header', async () => {
    const first = createWalWriter(directory, { indexName: 'movies', partitionId: 0 })
    await first.appendDurable(entry(1))
    await first.close()

    const second = createWalWriter(directory, { indexName: 'movies', partitionId: 0 })
    await second.appendDurable(entry(2))
    await second.close()

    const keys = segmentKeys(await directory.list('movies/wal/0/'))
    expect(keys).toEqual(['movies/wal/0/0000000000000001'])
    const entries = await readAllEntries(directory)
    expect(entries.map(e => e.seqNo)).toEqual([1, 2])
  })

  it('advances the commit marker to the new segment as part of a roll', async () => {
    const writer = createWalWriter(directory, { indexName: 'movies', partitionId: 0, segmentMaxBytes: 20 })
    await writer.append(entry(1))
    await writer.append(entry(2))

    const markerBytes = await directory.read('movies/wal/0/commit')
    expect(markerBytes).not.toBeNull()
    if (markerBytes === null) return
    const marker = readCommitMarker(markerBytes)
    const keys = segmentKeys(await directory.list('movies/wal/0/'))
    const newestStart = parseSegmentStartSeqNo(keys[keys.length - 1])
    expect(keys.length).toBeGreaterThan(1)
    expect(marker?.state.activeSegmentSeqNo).toBe(newestStart)

    await writer.close()
  })
})

describe('parseSegmentStartSeqNo', () => {
  it('parses a zero-padded sixteen-digit segment key', () => {
    expect(parseSegmentStartSeqNo('movies/wal/0/0000000000000005')).toBe(5)
  })

  it('throws on a malformed segment key instead of coercing to zero', () => {
    expect(() => parseSegmentStartSeqNo('movies/wal/0/not-a-number')).toThrow(/Malformed WAL segment key/)
    expect(() => parseSegmentStartSeqNo('movies/wal/0/commit')).toThrow(/Malformed WAL segment key/)
  })
})
