import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { AppendHandle, DurableDirectory } from './durable-filesystem'
import { createGroupCommitCoordinator } from './group-commit'
import { createMarkerWriter, type MarkerWriter } from './marker-writer'
import { frameRecord, SEGMENT_HEADER_SIZE, writeSegmentHeader } from './wal-framing'

export const DEFAULT_SEGMENT_MAX_BYTES = 67_108_864

const SEGMENT_TAIL_PATTERN = /^\d{16}$/

export interface WalWriterConfig {
  indexName: string
  partitionId: number
  segmentMaxBytes?: number
}

export interface WalWriter {
  append(entry: ReplicationLogEntry): Promise<void>
  appendDurable(entry: ReplicationLogEntry): Promise<void>
  commit(): Promise<void>
  rollToNewSegment(startSeqNo: number): Promise<void>
  close(): Promise<void>
  readonly activeSegmentKey: string | null
}

function segmentKey(indexName: string, partitionId: number, startSeqNo: number): string {
  const padded = startSeqNo.toString().padStart(16, '0')
  return `${indexName}/wal/${partitionId}/${padded}`
}

export function parseSegmentStartSeqNo(key: string): number {
  const tail = key.slice(key.lastIndexOf('/') + 1)
  if (!SEGMENT_TAIL_PATTERN.test(tail)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Malformed WAL segment key: "${key}"`, { key })
  }
  const value = Number.parseInt(tail, 10)
  if (!Number.isSafeInteger(value)) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `WAL segment start sequence number is out of range: "${key}"`,
      {
        key,
      },
    )
  }
  return value
}

export function createWalWriter(directory: DurableDirectory, config: WalWriterConfig): WalWriter {
  const segmentMaxBytes = config.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES
  const commitKey = `${config.indexName}/wal/${config.partitionId}/commit`

  let handle: AppendHandle | null = null
  let activeKey: string | null = null
  let activeStartSeqNo = 0
  let activeBytes = 0
  let highestAppendedSeqNo = 0
  let highestDurableSeqNo = 0
  let markerWriter: MarkerWriter | null = null
  let durabilityLock: Promise<unknown> = Promise.resolve()

  const coordinator = createGroupCommitCoordinator(() => withDurabilityLock(flushActiveSegment))

  function withDurabilityLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = durabilityLock.then(fn)
    durabilityLock = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function getMarkerWriter(): Promise<MarkerWriter> {
    if (markerWriter === null) {
      const writer = await createMarkerWriter(directory, config.indexName, config.partitionId)
      markerWriter = writer
      if (writer.existingHighestDurableSeqNo > highestDurableSeqNo) {
        highestDurableSeqNo = writer.existingHighestDurableSeqNo
      }
      if (writer.created) {
        await directory.syncDirectoryOf(commitKey)
      }
    }
    return markerWriter
  }

  async function flushActiveSegment(): Promise<void> {
    if (handle === null) {
      return
    }
    const writer = await getMarkerWriter()
    const durableByteLength = activeBytes
    const activeSegmentSeqNo = activeStartSeqNo
    const durableSeqNo = Math.max(highestAppendedSeqNo, highestDurableSeqNo)
    await handle.sync()
    await writer.commit({ activeSegmentSeqNo, durableByteLength, highestDurableSeqNo: durableSeqNo })
    if (durableSeqNo > highestDurableSeqNo) {
      highestDurableSeqNo = durableSeqNo
    }
  }

  async function openSegmentByKey(key: string): Promise<boolean> {
    const nextHandle = await directory.appendHandle(key)
    const existingSize = await nextHandle.size()
    let createdNew = false
    if (existingSize === 0) {
      await nextHandle.append(writeSegmentHeader())
      activeBytes = SEGMENT_HEADER_SIZE
      createdNew = true
    } else {
      activeBytes = existingSize
    }
    handle = nextHandle
    activeKey = key
    activeStartSeqNo = parseSegmentStartSeqNo(key)
    if (createdNew) {
      await directory.syncDirectoryOf(key)
    }
    return createdNew
  }

  async function findActiveSegmentKey(): Promise<string | null> {
    const prefix = `${config.indexName}/wal/${config.partitionId}/`
    const keys = (await directory.list(prefix)).filter(k => SEGMENT_TAIL_PATTERN.test(k.slice(prefix.length))).sort()
    return keys.length > 0 ? keys[keys.length - 1] : null
  }

  async function ensureSegment(seqNo: number): Promise<void> {
    if (handle !== null) {
      return
    }
    const existing = await findActiveSegmentKey()
    const createdNew = await openSegmentByKey(existing ?? segmentKey(config.indexName, config.partitionId, seqNo))
    if (createdNew) {
      await withDurabilityLock(flushActiveSegment)
    }
  }

  async function rollToNewSegment(startSeqNo: number): Promise<void> {
    await withDurabilityLock(async () => {
      if (handle !== null) {
        await flushActiveSegment()
        await handle.close()
        handle = null
      }
      await openSegmentByKey(segmentKey(config.indexName, config.partitionId, startSeqNo))
      await flushActiveSegment()
    })
  }

  async function maybeRoll(nextSeqNo: number): Promise<void> {
    if (handle !== null && activeBytes >= segmentMaxBytes) {
      await rollToNewSegment(nextSeqNo)
    }
  }

  async function appendFrame(entry: ReplicationLogEntry): Promise<void> {
    await ensureSegment(entry.seqNo)
    await maybeRoll(entry.seqNo)
    const activeHandle = handle
    if (activeHandle === null) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `WAL segment for "${config.indexName}" partition ${config.partitionId} is not open`,
        { indexName: config.indexName, partitionId: config.partitionId },
      )
    }
    const frame = frameRecord(entry)
    await activeHandle.append(frame)
    activeBytes += frame.length
    if (entry.seqNo > highestAppendedSeqNo) {
      highestAppendedSeqNo = entry.seqNo
    }
  }

  return {
    async append(entry: ReplicationLogEntry): Promise<void> {
      await appendFrame(entry)
    },

    async appendDurable(entry: ReplicationLogEntry): Promise<void> {
      await appendFrame(entry)
      await coordinator.commit()
    },

    async commit(): Promise<void> {
      await coordinator.commit()
    },

    rollToNewSegment,

    async close(): Promise<void> {
      await withDurabilityLock(async () => {
        if (handle !== null) {
          await flushActiveSegment()
          await handle.close()
          handle = null
        }
        if (markerWriter !== null) {
          await markerWriter.close()
          markerWriter = null
        }
        activeKey = null
      })
    },

    get activeSegmentKey(): string | null {
      return activeKey
    },
  }
}
