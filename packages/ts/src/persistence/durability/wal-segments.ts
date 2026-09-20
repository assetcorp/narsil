import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../errors'
import { readCommitMarker } from './commit-marker'
import type { DurableDirectory } from './durable-filesystem'
import { checkSegmentHeader, readDurableRegion, readTailBeyondFrontier } from './wal-framing'

export interface ActiveTail {
  key: string
  entries: ReplicationLogEntry[]
  cleanEnd: number
  segmentLength: number
}

export type CommitMarker = NonNullable<ReturnType<typeof readCommitMarker>>

export interface SegmentRef {
  key: string
  startSeqNo: number
}

export interface WalReadResult {
  marker: CommitMarker
  segments: SegmentRef[]
  durableEntries: ReplicationLogEntry[]
  activeTail: ActiveTail | null
  highestReadFromWal: number
}

interface OpenedWal {
  marker: CommitMarker
  segments: SegmentRef[]
}

interface SegmentRead {
  durableEntries: ReplicationLogEntry[]
  activeTail: ActiveTail | null
}

function walPrefix(indexName: string, partitionId: number): string {
  return `${indexName}/wal/${partitionId}/`
}

function segmentStartSeqNo(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix)) {
    return null
  }
  const tail = key.slice(prefix.length)
  if (!/^\d{16}$/.test(tail)) {
    return null
  }
  const value = Number.parseInt(tail, 10)
  return Number.isSafeInteger(value) ? value : null
}

async function collectSegments(directory: DurableDirectory, prefix: string): Promise<SegmentRef[]> {
  const keys = await directory.list(prefix)
  const refs: SegmentRef[] = []
  for (const key of keys) {
    const startSeqNo = segmentStartSeqNo(key, prefix)
    if (startSeqNo !== null) {
      refs.push({ key, startSeqNo })
    }
  }
  refs.sort((a, b) => a.startSeqNo - b.startSeqNo)
  return refs
}

async function openWal(directory: DurableDirectory, indexName: string, partitionId: number): Promise<OpenedWal | null> {
  const prefix = walPrefix(indexName, partitionId)
  const markerBytes = await directory.read(`${prefix}commit`)
  const marker = markerBytes === null ? null : readCommitMarker(markerBytes)
  if (marker === null) {
    return null
  }
  return { marker, segments: await collectSegments(directory, prefix) }
}

async function* readSegmentsInOrder(directory: DurableDirectory, wal: OpenedWal): AsyncGenerator<SegmentRead> {
  const { marker, segments } = wal
  let highestRead = 0
  for (const { key, startSeqNo } of segments) {
    if (startSeqNo > marker.state.activeSegmentSeqNo) {
      continue
    }
    const bytes = await directory.read(key)
    if (bytes === null) {
      continue
    }

    if (startSeqNo < marker.state.activeSegmentSeqNo) {
      const header = checkSegmentHeader(bytes)
      if (!header.ok) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_WAL_CORRUPT,
          `Sealed WAL segment header invalid: ${header.reason}`,
          {
            key,
            reason: header.reason,
          },
        )
      }
      const durableEntries = readDurableRegion(bytes, bytes.length)
      for (const entry of durableEntries) highestRead = Math.max(highestRead, entry.seqNo)
      yield { durableEntries, activeTail: null }
      continue
    }

    const durableEntries = readDurableRegion(bytes, marker.state.durableByteLength)
    for (const entry of durableEntries) highestRead = Math.max(highestRead, entry.seqNo)
    const tail = readTailBeyondFrontier(
      bytes,
      marker.state.durableByteLength,
      Math.max(highestRead, marker.state.highestDurableSeqNo),
    )
    yield {
      durableEntries,
      activeTail: { key, entries: tail.entries, cleanEnd: tail.cleanEnd, segmentLength: bytes.length },
    }
  }
}

export async function readWalSegments(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
): Promise<WalReadResult | null> {
  const wal = await openWal(directory, indexName, partitionId)
  if (wal === null) {
    return null
  }
  const durableEntries: ReplicationLogEntry[] = []
  let highestReadFromWal = 0
  let activeTail: ActiveTail | null = null
  for await (const segment of readSegmentsInOrder(directory, wal)) {
    for (const entry of segment.durableEntries) {
      durableEntries.push(entry)
      highestReadFromWal = Math.max(highestReadFromWal, entry.seqNo)
    }
    activeTail = segment.activeTail ?? activeTail
  }
  return { marker: wal.marker, segments: wal.segments, durableEntries, activeTail, highestReadFromWal }
}

export function durableRecordMissing(
  indexName: string,
  partitionId: number,
  highestRead: number,
  marker: CommitMarker,
): NarsilError {
  return new NarsilError(
    ErrorCodes.PERSISTENCE_WAL_CORRUPT,
    'A durable WAL record is missing: the highest recovered seqNo is below the commit marker',
    { indexName, partitionId, highestRead, highestDurable: marker.state.highestDurableSeqNo },
  )
}

export async function* walEntriesInRange(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  fromSeqNoExclusive: number,
  upToSeqNoInclusive: number,
): AsyncGenerator<ReplicationLogEntry> {
  const wal = await openWal(directory, indexName, partitionId)
  if (wal === null) {
    return
  }
  let highestRead = 0
  for await (const segment of readSegmentsInOrder(directory, wal)) {
    for (const entry of segment.durableEntries) {
      highestRead = Math.max(highestRead, entry.seqNo)
      if (entry.seqNo > fromSeqNoExclusive && entry.seqNo <= upToSeqNoInclusive) {
        yield entry
      }
    }
  }
  if (Math.max(fromSeqNoExclusive, highestRead) < wal.marker.state.highestDurableSeqNo) {
    throw durableRecordMissing(indexName, partitionId, highestRead, wal.marker)
  }
}
