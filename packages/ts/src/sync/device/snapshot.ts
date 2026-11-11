import { readHeapStatistics } from '#platform/heap-statistics'
import type { NarsilClient } from '../../client/client'
import type { RequestOptions } from '../../client/options'
import type { SyncSnapshotDownload } from '../../client/sync'
import { ClientErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { SyncSettings } from '../protocol'
import { analysisIsStale, requireAnalysisOnDevice } from './analysis'
import { type ArchiveFacts, readArchiveFacts } from './archive-facts'
import { DOWNLOAD_SAVE_BYTES, SNAPSHOT_MEMORY_PER_ARCHIVE_BYTE } from './constants'
import { holdsIndex } from './local-writes'
import type { DevicePosition, DeviceSyncStore, SavedDownload, SnapshotMemoryCheck } from './types'

const RANGE_NOT_SATISFIABLE = 416

export interface SnapshotContext {
  engine: Narsil
  indexName: string
  client: NarsilClient
  store: DeviceSyncStore
  requestOptions(): Promise<RequestOptions>
  chooseSnapshotLoad(check: SnapshotMemoryCheck): Promise<'load' | 'keep'>
  settings: SyncSettings | null
  appChoseLoad: boolean
}

export interface DownloadedSnapshot {
  kind: 'downloaded'
  saved: SavedDownload
  facts: ArchiveFacts
  dropOldCopy: boolean
}

export type SnapshotDownloadResult = DownloadedSnapshot | { kind: 'kept' }

async function startDownload(context: SnapshotContext): Promise<SyncSnapshotDownload> {
  const saved = await context.store.readDownload()
  const resume = saved === null ? undefined : { offset: saved.byteLength, entityTag: saved.entityTag }
  try {
    return await context.client.syncSnapshot(context.indexName, resume, await context.requestOptions())
  } catch (error) {
    if (resume === undefined || !(error instanceof NarsilError) || error.details.status !== RANGE_NOT_SATISFIABLE) {
      throw error
    }
    await context.store.clearDownload()
    return context.client.syncSnapshot(context.indexName, undefined, await context.requestOptions())
  }
}

async function mustDropOldCopy(context: SnapshotContext, archiveBytes: number): Promise<boolean | 'keep'> {
  if (!holdsIndex(context.engine, context.indexName)) return false
  const heap = readHeapStatistics()
  const requiredBytes = archiveBytes * SNAPSHOT_MEMORY_PER_ARCHIVE_BYTE
  if (heap === null || heap.usedBytes + requiredBytes <= heap.limitBytes) return false
  if (context.appChoseLoad) return true
  const choice = await context.chooseSnapshotLoad({ archiveBytes, requiredBytes, heapLimitBytes: heap.limitBytes })
  return choice === 'keep' ? 'keep' : true
}

async function saveDownload(context: SnapshotContext, download: SyncSnapshotDownload): Promise<void> {
  const reader = download.stream.getReader()
  let offset = download.offset
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  async function flush(): Promise<void> {
    if (pendingBytes === 0) return
    const batch = new Uint8Array(pendingBytes)
    let at = 0
    for (const part of pending) {
      batch.set(part, at)
      at += part.byteLength
    }
    await context.store.appendDownload(download.entityTag, offset, batch)
    offset += pendingBytes
    pending = []
    pendingBytes = 0
  }
  try {
    if (download.offset === 0) await context.store.appendDownload(download.entityTag, 0, new Uint8Array(0))
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + pendingBytes + value.byteLength > download.totalBytes) {
        throw new NarsilError(
          ClientErrorCodes.CLIENT_INVALID_RESPONSE,
          'The server sent more bytes than the snapshot holds',
        )
      }
      pending.push(value)
      pendingBytes += value.byteLength
      if (pendingBytes >= DOWNLOAD_SAVE_BYTES) await flush()
    }
    await flush()
  } catch (error) {
    await flush().catch(() => undefined)
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

function completeDownload(saved: SavedDownload | null, entityTag: string, totalBytes: number): SavedDownload {
  if (saved === null || saved.entityTag !== entityTag || saved.byteLength !== totalBytes) {
    throw new NarsilError(ClientErrorCodes.CLIENT_CONNECTION_FAILED, 'The snapshot download ended early', {
      saved: saved?.byteLength ?? 0,
      totalBytes,
    })
  }
  return saved
}

export async function downloadPublishedSnapshot(context: SnapshotContext): Promise<SnapshotDownloadResult> {
  if (context.settings !== null) requireAnalysisOnDevice(context.indexName, context.settings)
  const download = await startDownload(context)
  const dropOldCopy = await mustDropOldCopy(context, download.totalBytes)
  if (dropOldCopy === 'keep') {
    await download.stream.cancel().catch(() => undefined)
    return { kind: 'kept' }
  }
  await saveDownload(context, download)
  const saved = completeDownload(await context.store.readDownload(), download.entityTag, download.totalBytes)
  const facts = await readArchiveFacts(saved.chunks())
  requireAnalysisOnDevice(context.indexName, facts.analysis)
  return { kind: 'downloaded', saved, facts, dropOldCopy }
}

export async function restoreDownloadedSnapshot(
  context: SnapshotContext,
  downloaded: DownloadedSnapshot,
): Promise<DevicePosition> {
  await context.store.clearKeptEntries()
  if (downloaded.dropOldCopy && holdsIndex(context.engine, context.indexName)) {
    await context.engine.dropIndex(context.indexName)
  }
  await context.engine.restore(context.indexName, downloaded.saved.chunks())
  if (analysisIsStale(downloaded.facts.analysis)) await context.engine.rebuildAnalysis(context.indexName)
  return { epoch: downloaded.facts.epoch, seqNos: downloaded.facts.seqNos }
}
