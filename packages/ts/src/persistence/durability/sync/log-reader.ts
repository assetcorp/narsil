import { readCommitMarker } from '../commit-marker'
import type { DurableDirectory } from '../durable-filesystem'
import { SEGMENT_HEADER_SIZE } from '../wal-framing'
import { FrameCursor, type LogFrame, SegmentFileMissing } from './frame-cursor'
import { listHistorySegments } from './history'
import { parseWalSegmentStart, walSegmentPrefix } from './layout'

interface LogSource {
  key: string
  startSeqNo: number
  readableBytes: number
  inHistory: boolean
}

export interface PartitionLog {
  sources: LogSource[]
  head: number
  oldestSeqNo: number
}

export interface LogRead {
  frames: LogFrame[]
  bytes: number
  gone: boolean
}

async function walSources(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
): Promise<{ sources: LogSource[]; head: number }> {
  const prefix = walSegmentPrefix(indexName, partitionId)
  const markerBytes = await directory.read(`${prefix}commit`)
  const marker = markerBytes === null ? null : readCommitMarker(markerBytes)
  if (marker === null) return { sources: [], head: 0 }
  const { activeSegmentSeqNo, durableByteLength, highestDurableSeqNo } = marker.state
  const sources: LogSource[] = []
  for (const key of await directory.list(prefix)) {
    const startSeqNo = parseWalSegmentStart(indexName, partitionId, key)
    if (startSeqNo === null || startSeqNo > activeSegmentSeqNo) continue
    const readableBytes = startSeqNo === activeSegmentSeqNo ? durableByteLength : await directory.byteLength?.(key)
    if (readableBytes === null || readableBytes === undefined) continue
    sources.push({ key, startSeqNo, readableBytes, inHistory: false })
  }
  return { sources, head: highestDurableSeqNo }
}

export async function openPartitionLog(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
): Promise<PartitionLog> {
  const { sources, head } = await walSources(directory, indexName, partitionId)
  const byStart = new Map<number, LogSource>()
  for (const segment of await listHistorySegments(directory, indexName, partitionId)) {
    const readableBytes = await directory.byteLength?.(segment.key)
    if (readableBytes === null || readableBytes === undefined) continue
    byStart.set(segment.startSeqNo, {
      key: segment.key,
      startSeqNo: segment.startSeqNo,
      readableBytes,
      inHistory: true,
    })
  }
  for (const source of sources) if (!byStart.has(source.startSeqNo)) byStart.set(source.startSeqNo, source)
  const ordered = [...byStart.values()].sort((a, b) => a.startSeqNo - b.startSeqNo)
  return { sources: ordered, head, oldestSeqNo: ordered.length > 0 ? ordered[0].startSeqNo : head + 1 }
}

function sourceHolding(log: PartitionLog, seqNo: number): number {
  let found = -1
  for (let i = 0; i < log.sources.length; i++) {
    if (log.sources[i].startSeqNo > seqNo) break
    found = i
  }
  return found
}

async function offsetAfter(cursor: FrameCursor, source: LogSource, afterSeqNo: number): Promise<number> {
  let offset = SEGMENT_HEADER_SIZE
  for (let skip = afterSeqNo + 1 - source.startSeqNo; skip > 0 && offset < cursor.limit; skip--) {
    offset += await cursor.frameLengthAt(offset)
  }
  return offset
}

async function readSource(
  directory: DurableDirectory,
  source: LogSource,
  afterSeqNo: number,
  upToSeqNo: number,
  maxBytes: number,
  read: LogRead,
): Promise<boolean> {
  const cursor = new FrameCursor(directory, source.key, source.readableBytes)
  await cursor.checkHeader()
  let offset = await offsetAfter(cursor, source, afterSeqNo)
  let checksNumbering = true
  while (offset < cursor.limit) {
    const frame = await cursor.frameAt(offset, await cursor.frameLengthAt(offset))
    if (checksNumbering && frame.seqNo !== Math.max(afterSeqNo + 1, source.startSeqNo)) {
      checksNumbering = false
      if (frame.seqNo > afterSeqNo) {
        offset = SEGMENT_HEADER_SIZE
        continue
      }
    }
    checksNumbering = false
    offset += frame.frameBytes
    if (frame.seqNo <= afterSeqNo) continue
    if (frame.seqNo > upToSeqNo) return true
    if (read.frames.length > 0 && read.bytes + frame.payload.byteLength > maxBytes) return true
    read.frames.push(frame)
    read.bytes += frame.payload.byteLength
    if (frame.seqNo === upToSeqNo) return true
  }
  return false
}

export async function readPartitionLog(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  afterSeqNo: number,
  upToSeqNo: number,
  maxBytes: number,
): Promise<LogRead> {
  const read: LogRead = { frames: [], bytes: 0, gone: false }
  if (afterSeqNo >= upToSeqNo) return read
  for (let attempt = 0; attempt < 2; attempt++) {
    read.frames = []
    read.bytes = 0
    const log = await openPartitionLog(directory, indexName, partitionId)
    let index = sourceHolding(log, afterSeqNo + 1)
    if (index < 0) {
      read.gone = log.sources.length > 0 || afterSeqNo + 1 <= log.head
      return read
    }
    try {
      for (; index < log.sources.length; index++) {
        const from = Math.max(afterSeqNo, read.frames.at(-1)?.seqNo ?? afterSeqNo)
        if (await readSource(directory, log.sources[index], from, upToSeqNo, maxBytes, read)) break
      }
      return read
    } catch (error) {
      if (!(error instanceof SegmentFileMissing) || attempt > 0) throw error
    }
  }
  return read
}

export async function logBytesAfter(
  directory: DurableDirectory,
  log: PartitionLog,
  afterSeqNo: number,
): Promise<number> {
  const first = sourceHolding(log, afterSeqNo + 1)
  let bytes = 0
  for (let i = Math.max(first, 0); i < log.sources.length; i++) {
    const source = log.sources[i]
    if (i === first) {
      const cursor = new FrameCursor(directory, source.key, source.readableBytes)
      try {
        bytes += Math.max(0, source.readableBytes - (await offsetAfter(cursor, source, afterSeqNo)))
      } catch (error) {
        if (!(error instanceof SegmentFileMissing)) throw error
      }
      continue
    }
    bytes += Math.max(0, source.readableBytes - SEGMENT_HEADER_SIZE)
  }
  return bytes
}
