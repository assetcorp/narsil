import { ErrorCodes, NarsilError } from '../../../errors'
import type { DirectoryLock } from '../../../persistence/durability/directory-lock'
import {
  type AppendHandle,
  createDurableDirectory,
  type DurableDirectory,
} from '../../../persistence/durability/durable-filesystem'
import { loadMessagePack } from '../../../serialization/msgpack-code'
import { QUEUE_COMPACTION_BYTES } from '../constants'
import type { DeviceSyncStore, KeptEntry } from '../types'
import { openFilesystemDownload } from './filesystem-download'
import { frameOf, readFrames } from './frames'
import {
  decodeKeptEntries,
  decodePosition,
  encodeKeptEntries,
  encodePosition,
  encodeQueueRecord,
  replayQueue,
} from './records'
import { createSerial } from './serial'

const POSITION_KEY = 'position'
const QUEUE_KEY = 'queue.log'
const KEPT_KEY = 'kept.log'

/**
 * The settings of {@link createFilesystemDeviceStore}.
 *
 * @public
 */
export interface FilesystemDeviceStoreConfig {
  /** The store keeps its files in this directory, which it creates where it is missing and locks while it is open. */
  directory: string
}

interface FramedLog {
  handle: AppendHandle
  payloads: Uint8Array[]
}

async function openFramedLog(directory: DurableDirectory, key: string): Promise<FramedLog> {
  const bytes = (await directory.read(key)) ?? new Uint8Array(0)
  const { payloads, cleanLength } = readFrames(bytes)
  const handle = await directory.appendHandle(key)
  if (cleanLength !== bytes.byteLength) await handle.truncate(cleanLength)
  return { handle, payloads }
}

async function appendDurably(handle: AppendHandle, frames: readonly Uint8Array[]): Promise<void> {
  const before = await handle.size()
  try {
    for (const frame of frames) await handle.append(frame)
    await handle.sync()
  } catch (error) {
    await handle.truncate(before).catch(() => undefined)
    throw error
  }
}

/**
 * Opens a store that keeps a synced device's queue, kept feed entries, position, and snapshot download in files, for
 * an app on Node.js, Electron, or another runtime with `node:fs`.
 *
 * Each write reaches the disk through `fsync` before its promise resolves, and the store drops a record that a crash
 * cut short when it next opens. Only one store may hold the directory open at a time.
 *
 * @param config - The directory that holds the files.
 * @returns The open store, which {@link DeviceSyncStore.close} releases.
 * @public
 */
export async function createFilesystemDeviceStore(config: FilesystemDeviceStoreConfig): Promise<DeviceSyncStore> {
  if (typeof config.directory !== 'string' || config.directory.trim().length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The device sync store needs a directory')
  }
  await loadMessagePack()
  const directory = createDurableDirectory(config.directory)
  const lock: DirectoryLock | null = (await directory.lock?.()) ?? null
  try {
    return await openStore(directory, lock)
  } catch (error) {
    await lock?.release().catch(() => undefined)
    throw error
  }
}

async function openStore(directory: DurableDirectory, lock: DirectoryLock | null): Promise<DeviceSyncStore> {
  const serial = createSerial()
  const queueLog = await openFramedLog(directory, QUEUE_KEY)
  const queue = replayQueue(queueLog.payloads)
  let queueHandle = queueLog.handle
  let queueFileBytes = await queueHandle.size()
  const keptLog = await openFramedLog(directory, KEPT_KEY)
  let keptHandle = keptLog.handle
  const download = await openFilesystemDownload(directory)
  let closed = false

  function liveQueueBytes(): number {
    let total = 0
    for (const bytes of queue.recordBytes.values()) total += bytes
    return total
  }

  async function compactQueue(): Promise<void> {
    const frames = [frameOf(encodeQueueRecord({ type: 'next', sequence: queue.nextSequence }))]
    for (const write of [...queue.writes.values()].sort((a, b) => a.sequence - b.sequence)) {
      frames.push(frameOf(encodeQueueRecord({ type: 'write', write })))
    }
    await queueHandle.close()
    await directory.atomicWrite(QUEUE_KEY, frames)
    queueHandle = await directory.appendHandle(QUEUE_KEY)
    queueFileBytes = await queueHandle.size()
  }

  function guarded<T>(task: () => Promise<T>): Promise<T> {
    return serial.run(async () => {
      if (closed) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The device sync store is closed')
      return task()
    })
  }

  return {
    readPosition: () =>
      guarded(async () => {
        const bytes = await directory.read(POSITION_KEY)
        return bytes === null ? null : decodePosition(bytes)
      }),

    writePosition: position =>
      guarded(async () => {
        if (position === null) {
          await directory.remove(POSITION_KEY)
        } else {
          await directory.atomicWrite(POSITION_KEY, encodePosition(position))
        }
      }),

    appendWrite: write =>
      guarded(async () => {
        const queued = { sequence: queue.nextSequence, documentId: write.documentId, document: write.document }
        const frame = frameOf(encodeQueueRecord({ type: 'write', write: queued }))
        await appendDurably(queueHandle, [frame])
        queue.nextSequence += 1
        queue.writes.set(queued.sequence, queued)
        queue.recordBytes.set(queued.sequence, frame.byteLength)
        queueFileBytes += frame.byteLength
        return queued
      }),

    queuedWrites: () => guarded(async () => [...queue.writes.values()].sort((a, b) => a.sequence - b.sequence)),

    removeWrites: sequences =>
      guarded(async () => {
        const present = sequences.filter(sequence => queue.writes.has(sequence))
        if (present.length === 0) return
        const frame = frameOf(encodeQueueRecord({ type: 'removed', sequences: present }))
        await appendDurably(queueHandle, [frame])
        queueFileBytes += frame.byteLength
        for (const sequence of present) {
          queue.writes.delete(sequence)
          queue.recordBytes.delete(sequence)
        }
        if (queueFileBytes > QUEUE_COMPACTION_BYTES && liveQueueBytes() * 2 < queueFileBytes) await compactQueue()
      }),

    keepEntries: entries =>
      guarded(async () => {
        if (entries.length === 0) return
        await appendDurably(keptHandle, [frameOf(encodeKeptEntries(entries))])
      }),

    keptEntries: () =>
      guarded(async () => {
        const bytes = (await directory.read(KEPT_KEY)) ?? new Uint8Array(0)
        const kept: KeptEntry[] = []
        for (const payload of readFrames(bytes).payloads) kept.push(...decodeKeptEntries(payload))
        return kept
      }),

    clearKeptEntries: () =>
      guarded(async () => {
        await keptHandle.close()
        await directory.remove(KEPT_KEY)
        keptHandle = await directory.appendHandle(KEPT_KEY)
      }),

    appendDownload: (entityTag, offset, chunk) => guarded(() => download.append(entityTag, offset, chunk)),

    readDownload: () => guarded(async () => download.read()),

    clearDownload: () => guarded(() => download.clear()),

    close: () =>
      serial.run(async () => {
        if (closed) return
        closed = true
        await Promise.allSettled([queueHandle.close(), keptHandle.close(), download.close()])
        await lock?.release()
      }),
  }
}
