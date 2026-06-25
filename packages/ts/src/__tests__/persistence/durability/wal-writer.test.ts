import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegment } from '../../../persistence/durability/wal-framing'
import { createWalWriter } from '../../../persistence/durability/wal-writer'

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

async function readAllEntries(directory: DurableDirectory): Promise<ReplicationLogEntry[]> {
  const keys = await directory.list('movies/wal/0/')
  const entries: ReplicationLogEntry[] = []
  for (const key of keys.sort()) {
    const bytes = await directory.read(key)
    if (bytes === null) continue
    const result = readSegment(bytes, 67_108_864)
    if (result.kind === 'records') {
      entries.push(...result.entries)
    }
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

    const keys = await directory.list('movies/wal/0/')
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

    const keys = await directory.list('movies/wal/0/')
    expect(keys).toEqual(['movies/wal/0/0000000000000001'])
    const entries = await readAllEntries(directory)
    expect(entries.map(e => e.seqNo)).toEqual([1, 2])
  })
})
