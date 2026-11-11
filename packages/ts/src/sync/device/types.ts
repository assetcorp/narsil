import type { NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { AnyDocument } from '../../types/schema'

/**
 * One local write that the device holds until the server accepts it.
 *
 * @public
 */
export interface QueuedWrite {
  /** The store numbers each write upwards from 1, in the order that the app made them. */
  sequence: number
  /** The write changes the document with this ID. */
  documentId: string
  /** This is the whole document after the write, or `null` for a remove. */
  document: AnyDocument | null
}

/**
 * One feed entry that the device keeps on disk until its index holds the change durably.
 *
 * @public
 */
export interface KeptEntry {
  /** The entry belongs to this partition of the server's index. */
  partitionId: number
  /** This is the entry's sequence number in its partition. */
  seqNo: number
  /** The entry changes the document with this ID. */
  documentId: string
  /** This holds the MessagePack bytes of the whole document, or `null` for a remove. */
  document: Uint8Array | null
}

/**
 * The epoch and the position that the device's copy of the index holds durably.
 *
 * @public
 */
export interface DevicePosition {
  /** The copy belongs to this index epoch, 32 lowercase hexadecimal digits. */
  epoch: string
  /** Item `i` is the highest sequence number of partition `i` that the copy holds. */
  seqNos: number[]
}

/**
 * The part of a snapshot download that the device has saved, so that a restart can resume it.
 *
 * @public
 */
export interface SavedDownload {
  /** The saved bytes belong to the archive with this entity tag. */
  entityTag: string
  /** The store holds this many bytes from the start of the archive. */
  byteLength: number
  /** Reads the saved bytes from the first one. */
  chunks(): AsyncIterable<Uint8Array>
}

/**
 * Where a synced device keeps its queue, its kept feed entries, its position, and a snapshot download in progress.
 *
 * `@delali/narsil/sync/filesystem` and `@delali/narsil/sync/indexeddb` provide one each. Every method must finish its
 * write durably before its promise resolves, because the device acts on that promise.
 *
 * @public
 */
export interface DeviceSyncStore {
  /** Returns the saved position, or `null` before the device holds a copy. */
  readPosition(): Promise<DevicePosition | null>
  /** Saves the position, or clears it with `null`. */
  writePosition(position: DevicePosition | null): Promise<void>
  /** Saves one local write at the end of the queue and returns it with its sequence number. */
  appendWrite(write: Omit<QueuedWrite, 'sequence'>): Promise<QueuedWrite>
  /** Returns every queued write in sequence order. */
  queuedWrites(): Promise<QueuedWrite[]>
  /** Removes the queued writes with these sequence numbers. */
  removeWrites(sequences: readonly number[]): Promise<void>
  /** Saves feed entries after the ones that the store already keeps. */
  keepEntries(entries: readonly KeptEntry[]): Promise<void>
  /** Returns every kept entry in the order that the store saved them. */
  keptEntries(): Promise<KeptEntry[]>
  /** Removes every kept entry. */
  clearKeptEntries(): Promise<void>
  /**
   * Saves the next bytes of a snapshot download. An `offset` of 0 starts a new download and drops the saved one, and
   * any other `offset` must equal the saved length under the same entity tag.
   */
  appendDownload(entityTag: string, offset: number, chunk: Uint8Array): Promise<void>
  /** Returns the saved part of a snapshot download, or `null` where the store holds none. */
  readDownload(): Promise<SavedDownload | null>
  /** Removes the saved snapshot download. */
  clearDownload(): Promise<void>
  /** Releases the files or the database that the store holds open. */
  close(): Promise<void>
}

/**
 * What became of one queued write that a developer's own backend received.
 *
 * @public
 */
export type UploadOutcome =
  | { accepted: true }
  | {
      accepted: false
      error: NarsilError
      /**
       * The backend's copy of the document, or `null` where it holds none. The device reads the copy from the
       * server's document routes where this is absent.
       */
      serverDocument?: AnyDocument | null
    }

/**
 * A local write that the server refused, which the device reports once it has replaced its own copy with the
 * server's.
 *
 * @public
 */
export interface RefusedWrite {
  /** The device made this write. */
  write: QueuedWrite
  /** The server refused it with this error. */
  error: NarsilError
  /** The device now holds the server's copy of the document, or no document where the server holds none. */
  serverDocument: AnyDocument | null
}

/**
 * What the device has to download to replace its copy, which {@link DeviceSyncOptions.chooseSnapshotLoad} weighs.
 *
 * @public
 */
export interface SnapshotMemoryCheck {
  /** The archive holds this many bytes. */
  archiveBytes: number
  /** The device estimates that it needs this many bytes of heap to hold the old and the new copy together. */
  requiredBytes: number
  /** The heap may grow to this many bytes. */
  heapLimitBytes: number
}

/**
 * The state that {@link DeviceSync.status} reports.
 *
 * @public
 */
export interface DeviceSyncStatus {
  /** `connected` while the feed is open, `connecting` between attempts, and `stopped` after {@link DeviceSync.stop}. */
  connection: 'connected' | 'connecting' | 'stopped'
  /** The device holds this many local writes that the server has not accepted. */
  queuedWrites: number
  /** The copy holds this position, or `null` before its first snapshot. */
  position: DevicePosition | null
  /** This is true while the app has chosen to keep its old copy instead of loading a new snapshot. */
  snapshotDeferred: boolean
}

/**
 * The settings of {@link createDeviceSync}.
 *
 * @public
 */
export interface DeviceSyncOptions {
  /** The engine on the device that holds the synced copy. */
  engine: Narsil
  /** The device syncs the index with this name, which is the same on the device and on the server. */
  indexName: string
  /** The server's base URL, such as `https://search.example.com`. */
  url: string
  /** The device keeps its queue, its kept entries, and its position here. */
  store: DeviceSyncStore
  /**
   * Returns the credential that the device sends with each request, as a bearer token over HTTP and as a
   * `Sec-WebSocket-Protocol` value on the feed. The device calls it again after the server closes the feed at the
   * credential's expiry.
   */
  credential?: () => string | null | Promise<string | null>
  /**
   * Sends queued writes through the developer's own backend, which then decides each conflict. The device sends
   * them through the server's document routes where this is absent.
   */
  upload?: (writes: readonly QueuedWrite[]) => Promise<UploadOutcome[]>
  /**
   * Makes every change that the engine has applied to the index durable. The device saves its position only after
   * this resolves. It defaults to a checkpoint of the index.
   */
  makeDurable?: () => Promise<void>
  /**
   * Decides whether to drop the old copy and load a new snapshot, where the device estimates that the old and the new
   * copy can't both fit in memory. The device drops the old copy where this is absent.
   */
  chooseSnapshotLoad?: (check: SnapshotMemoryCheck) => Promise<'load' | 'keep'>
  /** Hears about each local write that the server refused, after the device holds the server's copy. */
  onRefusedWrite?: (refused: RefusedWrite) => void
  /** Hears about each error that the device recovers from by retrying. */
  onError?: (error: unknown) => void
  /**
   * The device replays the feed while it is at most this many times the published snapshot's length behind, and it
   * loads the snapshot otherwise. It defaults to 1.
   */
  replayLimitOfSnapshot?: number
}

/**
 * Keeps one index on a device in step with the server, through local writes that work offline.
 *
 * @public
 */
export interface DeviceSync {
  /**
   * Saves a whole document under its ID on the device, where a search sees it at once, and queues it for the server.
   *
   * @param documentId - The document's ID.
   * @param document - The whole document.
   */
  put(documentId: string, document: AnyDocument): Promise<void>
  /**
   * Removes a document on the device and queues the remove for the server. Removing a missing document succeeds.
   *
   * @param documentId - The document's ID.
   */
  remove(documentId: string): Promise<void>
  /** Connects to the server and keeps reconnecting until {@link DeviceSync.stop}. */
  start(): Promise<void>
  /** Closes the feed, waits for the device's own work, and leaves the store open. */
  stop(): Promise<void>
  /** Loads a new snapshot that the app deferred through {@link DeviceSyncOptions.chooseSnapshotLoad}. */
  loadSnapshot(): Promise<void>
  /** Resolves once the device has sent every queued write and holds every change up to the server's heads. */
  settled(): Promise<void>
  /** Reports the connection, the queue, and the position. */
  status(): DeviceSyncStatus
}
