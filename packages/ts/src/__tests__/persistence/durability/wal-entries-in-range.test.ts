import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { walEntriesInRange } from '../../../persistence/durability/wal-segments'
import { createWalWriter } from '../../../persistence/durability/wal-writer'

const DOCUMENT_BYTES = 64
const SEGMENT_MAX_BYTES = 1024

function entry(seqNo: number): ReplicationLogEntry {
  return buildEntry({
    seqNo,
    primaryTerm: 1,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'movies',
    documentId: `doc-${seqNo}`,
    document: new Uint8Array(DOCUMENT_BYTES).fill(seqNo & 0xff),
  })
}

describe('the log entries that a checkpoint reads', () => {
  let root: string
  let directory: DurableDirectory

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-wal-range-'))
    directory = createDurableDirectory(root)
    const writer = createWalWriter(directory, {
      indexName: 'movies',
      partitionId: 0,
      segmentMaxBytes: SEGMENT_MAX_BYTES,
    })
    for (let seqNo = 1; seqNo <= 30; seqNo++) await writer.appendDurable(entry(seqNo))
    await writer.close()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('arrive one log segment at a time, so that a checkpoint never holds the whole log', async () => {
    const events: string[] = []
    const watched: DurableDirectory = {
      ...directory,
      async read(key) {
        if (/\/\d{16}$/.test(key)) events.push('segment')
        return directory.read(key)
      },
    }

    for await (const found of walEntriesInRange(watched, 'movies', 0, 0, 30)) events.push(`entry ${found.seqNo}`)

    const segmentsRead = events.filter(event => event === 'segment').length
    expect(segmentsRead).toBeGreaterThan(2)
    expect(events.filter(event => event !== 'segment')).toEqual(Array.from({ length: 30 }, (_, i) => `entry ${i + 1}`))
    expect(events.lastIndexOf('segment')).toBeGreaterThan(events.indexOf('entry 1'))
    expect(events.indexOf('entry 30')).toBeGreaterThan(events.lastIndexOf('segment'))
  })

  it('cover only the sequence numbers that the checkpoint asks for', async () => {
    const found: number[] = []
    for await (const each of walEntriesInRange(directory, 'movies', 0, 10, 20)) found.push(each.seqNo)
    expect(found).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  })

  it('fail once the log ends below the sequence number that the commit marker calls durable', async () => {
    const keys = (await directory.list('movies/wal/0/')).filter(key => /\/\d{16}$/.test(key)).sort()
    await directory.remove(keys[keys.length - 2])
    await directory.remove(keys[keys.length - 1])

    const read = async (): Promise<void> => {
      for await (const _ of walEntriesInRange(directory, 'movies', 0, 0, 30));
    }
    await expect(read()).rejects.toMatchObject({ code: 'PERSISTENCE_WAL_CORRUPT' })
  })
})
