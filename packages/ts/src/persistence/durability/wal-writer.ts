import {
  compareCodePoints,
  ErrorCodes,
  MAX_FILE_BYTES,
  NarsilError,
  turnIsSpent,
  turnsAreBudgeted,
  yieldTurn,
} from '#platform/storage-host'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { DEFAULT_SEGMENT_MAX_BYTES } from './constants'
import type { AppendHandle, DurableDirectory } from './durable-filesystem'
import { createGroupCommitCoordinator } from './group-commit'
import { createMarkerWriter, type MarkerWriter } from './marker-writer'
import {
  frameRecord,
  joinFrames,
  SEGMENT_HEADER_SIZE,
  WAL_FORMAT_VERSION,
  WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT,
  writeSegmentHeader,
} from './wal-framing'
import {
  nextSegmentKey,
  parseSegmentStartSeqNo,
  rewrittenHeaderKey,
  SEGMENT_TAIL_PATTERN,
  segmentKey,
} from './wal-segments'

export interface WalWriterConfig {
  indexName: string
  partitionId: number
  segmentMaxBytes?: number
  recordsPreviousDocument?: () => boolean
}

export interface WalWriter {
  appendAll(entries: readonly ReplicationLogEntry[]): Promise<void>
  appendDurable(entry: ReplicationLogEntry): Promise<void>
  commit(): Promise<void>
  rollToNewSegment(startSeqNo: number): Promise<void>
  prepareCheckpointRoll(): Promise<void>
  rollForCheckpoint(): Promise<void>
  close(): Promise<void>
  abandon(): Promise<void>
  readonly activeSegmentKey: string | null
}

export function createWalWriter(directory: DurableDirectory, config: WalWriterConfig): WalWriter {
  const segmentMaxBytes = config.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES
  const commitKey = `${config.indexName}/wal/${config.partitionId}/commit`
  const preparedKey = nextSegmentKey(config.indexName, config.partitionId)
  const rewrittenKey = rewrittenHeaderKey(config.indexName, config.partitionId)

  let nextSegmentPrepared = false
  let preparedFormatVersion = WAL_FORMAT_VERSION
  let handle: AppendHandle | null = null
  let activeKey: string | null = null
  let activeStartSeqNo = 0
  let activeBytes = 0
  let activeFormatVersion = WAL_FORMAT_VERSION
  let highestAppendedSeqNo = 0
  let highestDurableSeqNo = 0
  let markerWriter: MarkerWriter | null = null
  let durabilityLock: Promise<unknown> = Promise.resolve()
  let synced: { startSeqNo: number; bytes: number } | null = null
  let failure: { error: unknown } | null = null

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

  function latchFailure(err: unknown): unknown {
    if (failure === null) {
      failure = { error: err }
    }
    return failure.error
  }

  async function flushActiveSegment(): Promise<void> {
    if (failure !== null) {
      throw failure.error
    }
    const flushing = handle
    if (flushing === null) {
      return
    }
    const durableByteLength = activeBytes
    const activeSegmentSeqNo = activeStartSeqNo
    const appendedSeqNo = highestAppendedSeqNo
    if (synced !== null && synced.startSeqNo === activeSegmentSeqNo && synced.bytes === durableByteLength) {
      return
    }
    try {
      const writer = await getMarkerWriter()
      const durableSeqNo = Math.max(appendedSeqNo, highestDurableSeqNo)
      await flushing.sync()
      await writer.commit({ activeSegmentSeqNo, durableByteLength, highestDurableSeqNo: durableSeqNo })
      if (durableSeqNo > highestDurableSeqNo) {
        highestDurableSeqNo = durableSeqNo
      }
      synced = { startSeqNo: activeSegmentSeqNo, bytes: durableByteLength }
    } catch (err) {
      throw latchFailure(err)
    }
  }

  function formatVersionFor(holdsPreviousDocument: boolean): number {
    return holdsPreviousDocument || config.recordsPreviousDocument?.() === true
      ? WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT
      : WAL_FORMAT_VERSION
  }

  async function openSegmentByKey(key: string, formatVersion: number): Promise<boolean> {
    const nextHandle = await directory.appendHandle(key)
    const existingSize = await nextHandle.size()
    let createdNew = false
    if (existingSize === 0) {
      await nextHandle.append(writeSegmentHeader(formatVersion))
      activeBytes = SEGMENT_HEADER_SIZE
      activeFormatVersion = formatVersion
      createdNew = true
    } else {
      activeBytes = existingSize
      activeFormatVersion = WAL_FORMAT_VERSION
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
    const keys = (await directory.list(prefix))
      .filter(k => SEGMENT_TAIL_PATTERN.test(k.slice(prefix.length)))
      .sort(compareCodePoints)
    return keys.length > 0 ? keys[keys.length - 1] : null
  }

  async function ensureSegment(seqNo: number, holdsPreviousDocument: boolean): Promise<void> {
    if (handle !== null) {
      return
    }
    const existing = await findActiveSegmentKey()
    const createdNew = await openSegmentByKey(
      existing ?? segmentKey(config.indexName, config.partitionId, seqNo),
      formatVersionFor(holdsPreviousDocument),
    )
    if (createdNew) {
      await withDurabilityLock(flushActiveSegment)
    }
  }

  async function rollUnderLock(startSeqNo: number, formatVersion: number = formatVersionFor(false)): Promise<void> {
    if (handle !== null) {
      await flushActiveSegment()
      await handle.close()
      handle = null
    }
    await openSegmentByKey(segmentKey(config.indexName, config.partitionId, startSeqNo), formatVersion)
    await flushActiveSegment()
  }

  async function rollToNewSegment(startSeqNo: number): Promise<void> {
    await withDurabilityLock(() => rollUnderLock(startSeqNo))
  }

  async function rewriteEmptySegmentHeader(formatVersion: number): Promise<void> {
    const key = activeKey
    if (handle === null || key === null) return
    const rewritten = await directory.appendHandle(rewrittenKey)
    try {
      if ((await rewritten.size()) > 0) await rewritten.truncate(0)
      await rewritten.append(writeSegmentHeader(formatVersion))
      await rewritten.sync()
    } finally {
      await rewritten.close()
    }
    await handle.close()
    handle = null
    await directory.move(rewrittenKey, key)
    handle = await directory.appendHandle(key)
    activeBytes = SEGMENT_HEADER_SIZE
    activeFormatVersion = formatVersion
  }

  async function openSegmentForPreviousDocuments(startSeqNo: number): Promise<void> {
    if (activeFormatVersion >= WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT) return
    await withDurabilityLock(async () => {
      if (activeFormatVersion >= WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT) return
      if (activeBytes > SEGMENT_HEADER_SIZE) {
        await rollUnderLock(startSeqNo, WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT)
      } else {
        await rewriteEmptySegmentHeader(WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT)
      }
    })
  }

  function activeSegmentHoldsRecords(): boolean {
    return handle !== null && activeBytes > SEGMENT_HEADER_SIZE && highestAppendedSeqNo >= activeStartSeqNo
  }

  async function prepareNextSegment(): Promise<void> {
    const prepared = await directory.appendHandle(preparedKey)
    const formatVersion = formatVersionFor(false)
    try {
      if ((await prepared.size()) > 0) await prepared.truncate(0)
      await prepared.append(writeSegmentHeader(formatVersion))
      await prepared.sync()
      preparedFormatVersion = formatVersion
      nextSegmentPrepared = true
    } finally {
      await prepared.close()
    }
  }

  async function swapToPreparedSegment(sealed: AppendHandle): Promise<void> {
    if (failure !== null) {
      throw failure.error
    }
    try {
      const writer = await getMarkerWriter()
      const startSeqNo = highestAppendedSeqNo + 1
      const durableSeqNo = Math.max(highestAppendedSeqNo, highestDurableSeqNo)
      const key = segmentKey(config.indexName, config.partitionId, startSeqNo)
      await Promise.all([sealed.sync(), directory.move(preparedKey, key)])
      handle = await directory.appendHandle(key)
      activeKey = key
      activeStartSeqNo = startSeqNo
      activeBytes = SEGMENT_HEADER_SIZE
      activeFormatVersion = preparedFormatVersion
      await writer.commit({
        activeSegmentSeqNo: startSeqNo,
        durableByteLength: SEGMENT_HEADER_SIZE,
        highestDurableSeqNo: durableSeqNo,
      })
      highestDurableSeqNo = durableSeqNo
      synced = { startSeqNo, bytes: SEGMENT_HEADER_SIZE }
    } catch (err) {
      throw latchFailure(err)
    }
    await sealed.close()
  }

  async function maybeRoll(nextSeqNo: number, appendedBytes: number, holdsPreviousDocument: boolean): Promise<void> {
    if (handle === null || activeBytes <= SEGMENT_HEADER_SIZE) {
      return
    }
    if (activeBytes >= segmentMaxBytes || activeBytes + appendedBytes > segmentMaxBytes) {
      await withDurabilityLock(() => rollUnderLock(nextSeqNo, formatVersionFor(holdsPreviousDocument)))
    }
  }

  function framesThatFit(frames: readonly Uint8Array[], start: number): number {
    const room = segmentMaxBytes - activeBytes
    let end = start + 1
    let bytes = frames[start].length
    while (end < frames.length && bytes + frames[end].length <= room) {
      bytes += frames[end].length
      end += 1
    }
    return end
  }

  async function appendGroup(frames: readonly Uint8Array[], entries: readonly ReplicationLogEntry[]): Promise<void> {
    const activeHandle = handle
    if (activeHandle === null) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `WAL segment for "${config.indexName}" partition ${config.partitionId} is not open`,
        { indexName: config.indexName, partitionId: config.partitionId },
      )
    }
    const joined = joinFrames([...frames])
    if (activeBytes + joined.length > MAX_FILE_BYTES) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `A log record of ${joined.length} bytes would carry WAL segment "${activeKey}" past the file size limit of ${MAX_FILE_BYTES} bytes`,
        { indexName: config.indexName, partitionId: config.partitionId, bytes: joined.length },
      )
    }
    await activeHandle.append(joined)
    activeBytes += joined.length
    const lastSeqNo = entries[entries.length - 1].seqNo
    if (lastSeqNo > highestAppendedSeqNo) {
      highestAppendedSeqNo = lastSeqNo
    }
  }

  async function appendFrames(entries: readonly ReplicationLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return
    }
    const frames: Uint8Array[] = []
    let holdsPreviousDocument = false
    for (const entry of entries) {
      if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
      if (entry.previousDocument !== undefined) holdsPreviousDocument = true
      frames.push(frameRecord(entry))
    }
    await ensureSegment(entries[0].seqNo, holdsPreviousDocument)
    if (holdsPreviousDocument) await openSegmentForPreviousDocuments(entries[0].seqNo)
    let start = 0
    while (start < frames.length) {
      await maybeRoll(entries[start].seqNo, frames[start].length, holdsPreviousDocument)
      const end = framesThatFit(frames, start)
      await appendGroup(frames.slice(start, end), entries.slice(start, end))
      start = end
    }
  }

  return {
    async appendAll(entries: readonly ReplicationLogEntry[]): Promise<void> {
      await appendFrames(entries)
    },

    async appendDurable(entry: ReplicationLogEntry): Promise<void> {
      await appendFrames([entry])
      await coordinator.commit()
    },

    async commit(): Promise<void> {
      await coordinator.commit()
    },

    rollToNewSegment,

    async prepareCheckpointRoll(): Promise<void> {
      if (activeSegmentHoldsRecords()) await prepareNextSegment()
    },

    async rollForCheckpoint(): Promise<void> {
      await withDurabilityLock(async () => {
        const sealed = handle
        const prepared = nextSegmentPrepared
        nextSegmentPrepared = false
        if (sealed === null || !activeSegmentHoldsRecords()) return
        if (prepared) await swapToPreparedSegment(sealed)
        else await rollUnderLock(highestAppendedSeqNo + 1)
      })
    },

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

    async abandon(): Promise<void> {
      await withDurabilityLock(async () => {
        const closing = [handle?.close(), markerWriter?.close()]
        handle = null
        markerWriter = null
        activeKey = null
        await Promise.allSettled(closing)
      })
    },

    get activeSegmentKey(): string | null {
      return activeKey
    },
  }
}
