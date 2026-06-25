import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { AppendHandle, DurableDirectory } from './durable-filesystem'
import { createGroupCommitCoordinator, type GroupCommitCoordinator } from './group-commit'
import { createMarkerWriter, type MarkerWriter } from './marker-writer'
import { frameRecord, SEGMENT_HEADER_SIZE, writeSegmentHeader } from './wal-framing'

export const DEFAULT_SEGMENT_MAX_BYTES = 67_108_864

export interface WalWriterConfig {
  indexName: string
  partitionId: number
  segmentMaxBytes?: number
}

export interface WalWriter {
  append(entry: ReplicationLogEntry): Promise<void>
  appendDurable(entry: ReplicationLogEntry): Promise<void>
  commit(): Promise<void>
  commitSoft(): Promise<void>
  rollToNewSegment(startSeqNo: number): Promise<void>
  close(): Promise<void>
  readonly activeSegmentKey: string | null
}

function segmentKey(indexName: string, partitionId: number, startSeqNo: number): string {
  const padded = startSeqNo.toString().padStart(16, '0')
  return `${indexName}/wal/${partitionId}/${padded}`
}

function parseStartSeqNo(key: string): number {
  const tail = key.slice(key.lastIndexOf('/') + 1)
  const value = Number.parseInt(tail, 10)
  return Number.isSafeInteger(value) ? value : 0
}

export function createWalWriter(directory: DurableDirectory, config: WalWriterConfig): WalWriter {
  const segmentMaxBytes = config.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES
  let handle: AppendHandle | null = null
  let activeKey: string | null = null
  let activeStartSeqNo = 0
  let activeBytes = 0
  let highestAppendedSeqNo = 0
  let highestDurableSeqNo = 0
  let coordinator: GroupCommitCoordinator | null = null
  let markerWriter: MarkerWriter | null = null

  async function getMarkerWriter(): Promise<MarkerWriter> {
    if (markerWriter === null) {
      const writer = await createMarkerWriter(directory, config.indexName, config.partitionId)
      markerWriter = writer
      if (writer.existingHighestDurableSeqNo > highestDurableSeqNo) {
        highestDurableSeqNo = writer.existingHighestDurableSeqNo
      }
      if (writer.created) {
        await directory.syncDirectoryOf(`${config.indexName}/wal/${config.partitionId}/commit`)
      }
    }
    return markerWriter
  }

  async function flushMarker(fsync: boolean): Promise<void> {
    if (handle === null) {
      return
    }
    if (fsync) {
      await handle.sync()
    }
    const durableByteLength = activeBytes
    const durableSeqNo = Math.max(highestAppendedSeqNo, highestDurableSeqNo)
    const writer = await getMarkerWriter()
    await writer.commit(
      {
        activeSegmentSeqNo: activeStartSeqNo,
        durableByteLength,
        highestDurableSeqNo: durableSeqNo,
      },
      fsync,
    )
    highestDurableSeqNo = durableSeqNo
  }

  async function syncSegmentThenMarker(): Promise<void> {
    await flushMarker(true)
  }

  async function openSegmentByKey(key: string): Promise<void> {
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
    activeStartSeqNo = parseStartSeqNo(key)
    coordinator = createGroupCommitCoordinator(syncSegmentThenMarker)
    if (createdNew) {
      await directory.syncDirectoryOf(key)
    }
  }

  async function openSegment(startSeqNo: number): Promise<void> {
    await openSegmentByKey(segmentKey(config.indexName, config.partitionId, startSeqNo))
  }

  async function findActiveSegmentKey(): Promise<string | null> {
    const prefix = `${config.indexName}/wal/${config.partitionId}/`
    const keys = (await directory.list(prefix)).filter(k => /\/\d{16}$/.test(k)).sort()
    return keys.length > 0 ? keys[keys.length - 1] : null
  }

  async function ensureSegment(seqNo: number): Promise<void> {
    if (handle !== null) {
      return
    }
    const existing = await findActiveSegmentKey()
    if (existing !== null) {
      await openSegmentByKey(existing)
      return
    }
    await openSegment(seqNo)
  }

  async function maybeRoll(nextSeqNo: number): Promise<void> {
    if (handle !== null && activeBytes >= segmentMaxBytes) {
      await rollToNewSegment(nextSeqNo)
    }
  }

  async function rollToNewSegment(startSeqNo: number): Promise<void> {
    if (handle !== null) {
      await syncSegmentThenMarker()
      await handle.close()
      handle = null
    }
    await openSegment(startSeqNo)
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
      if (coordinator === null) {
        return
      }
      await coordinator.commit()
    },

    async commit(): Promise<void> {
      if (coordinator === null) {
        return
      }
      await coordinator.commit()
    },

    async commitSoft(): Promise<void> {
      await flushMarker(false)
    },

    rollToNewSegment,

    async close(): Promise<void> {
      if (handle !== null) {
        await syncSegmentThenMarker()
        await handle.close()
        handle = null
      }
      if (markerWriter !== null) {
        await markerWriter.close()
        markerWriter = null
      }
      activeKey = null
      coordinator = null
    },

    get activeSegmentKey(): string | null {
      return activeKey
    },
  }
}
