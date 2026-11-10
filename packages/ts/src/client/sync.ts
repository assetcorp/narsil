import { ClientErrorCodes, NarsilError } from '../errors'
import { encodeJson } from '../json-encoding'
import type { SyncSetting, SyncStatus } from '../types/sync'
import { NO_TIMEOUT } from './constants'
import type { Transport } from './http'
import type { RequestOptions } from './options'
import { indexPath } from './paths'
import { readBody } from './response-shape'

/**
 * Where a download of the published snapshot carries on from, which
 * {@link SyncSettingOperations.syncSnapshot} takes.
 *
 * @public
 */
export interface SyncSnapshotResume {
  /** The download carries on from this byte of the archive. */
  offset: number
  /** The earlier part of the download carried this entity tag, which the server compares with the current one. */
  entityTag: string
}

/**
 * One download of the published snapshot of an index.
 *
 * @public
 */
export interface SyncSnapshotDownload {
  /** The archive carries this entity tag, 64 lowercase hexadecimal digits, which changes with each new snapshot. */
  entityTag: string
  /**
   * The stream starts at this byte of the archive. It is 0 where the server
   * published a new snapshot after the earlier part, so the caller starts
   * again from the first byte.
   */
  offset: number
  /** The whole archive holds this many bytes. */
  totalBytes: number
  /** The bytes of the archive from `offset` to its end. */
  stream: ReadableStream<Uint8Array>
}

const ENTITY_TAG = /^"([0-9a-f]{64})"$/
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/

function invalidDownload(message: string, path: string): NarsilError {
  return new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, message, { url: path })
}

/**
 * These methods read and replace the device sync setting of an index, as
 * {@link SyncOperations} does on the engine.
 *
 * @public
 */
export interface SyncSettingOperations {
  /**
   * Returns the device sync state of an index, as {@link SyncOperations.getSync}
   * does on the engine.
   *
   * @param indexName - The server reports the state of this index.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The setting, whether a device has asked for the published
   * snapshot, and the epoch.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` when no index has that name.
   */
  getSync(indexName: string, options?: RequestOptions): Promise<SyncStatus>
  /**
   * Replaces the device sync setting of an index. Turning sync on gives the
   * index a new epoch, and turning it off deletes the published snapshot and
   * the history and closes every feed of the index.
   *
   * @param indexName - The server replaces the setting of this index.
   * @param setting - This is the new setting.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @throws A `NarsilError` with `SYNC_DURABILITY_REQUIRED` when the server's
   * engine has no write-ahead log durability, and with `CONFIG_INVALID` when a
   * history limit is not a positive whole number.
   */
  updateSync(indexName: string, setting: SyncSetting, options?: RequestOptions): Promise<void>
  /**
   * Downloads the published snapshot of an index with device sync on, or the
   * rest of it from where an earlier download stopped. The archive restores
   * through {@link Narsil.restore} like any other snapshot archive.
   *
   * @param indexName - The server sends the snapshot of this index.
   * @param resume - Where an earlier download of the same snapshot stopped.
   * @param options - This sets the signal, the deadline, and the headers for
   * this request.
   * @returns The stream, the byte it starts from, the archive's length, and
   * its entity tag.
   * @throws A `NarsilError` with `SYNC_NOT_ENABLED` when the index has sync
   * off, and with `SYNC_SNAPSHOT_PREPARING` while a cluster node takes the
   * backup that the snapshot needs.
   */
  syncSnapshot(indexName: string, resume?: SyncSnapshotResume, options?: RequestOptions): Promise<SyncSnapshotDownload>
}

export function createSyncSettingOperations(transport: Transport): SyncSettingOperations {
  return {
    async getSync(indexName, options) {
      const path = `${indexPath(indexName)}/sync`
      return readBody<SyncStatus>(await transport.json({ method: 'GET', path, options }), path)
    },
    async updateSync(indexName, setting, options) {
      const path = `${indexPath(indexName)}/sync`
      await transport.json({ method: 'PUT', path, body: encodeJson(setting), contentType: 'application/json', options })
    },
    async syncSnapshot(indexName, resume, options) {
      const path = `${indexPath(indexName)}/sync/snapshot`
      const headers: Record<string, string> =
        resume === undefined || resume.offset <= 0
          ? {}
          : { range: `bytes=${resume.offset}-`, 'if-range': `"${resume.entityTag}"` }
      const answer = await transport.download({ method: 'GET', path, headers, defaultTimeoutMs: NO_TIMEOUT, options })
      const entityTag = ENTITY_TAG.exec(answer.headers.get('etag') ?? '')?.[1]
      if (entityTag === undefined) {
        await answer.stream.cancel()
        throw invalidDownload('The server sent the snapshot without an entity tag', path)
      }
      if (answer.status === 206) {
        const range = CONTENT_RANGE.exec(answer.headers.get('content-range') ?? '')
        if (range === null || Number(range[1]) !== resume?.offset) {
          await answer.stream.cancel()
          throw invalidDownload('The server sent a byte range other than the one that the client asked for', path)
        }
        return { entityTag, offset: Number(range[1]), totalBytes: Number(range[3]), stream: answer.stream }
      }
      const length = Number(answer.headers.get('content-length') ?? Number.NaN)
      if (!Number.isSafeInteger(length)) {
        await answer.stream.cancel()
        throw invalidDownload('The server sent the snapshot without its length', path)
      }
      return { entityTag, offset: 0, totalBytes: length, stream: answer.stream }
    },
  }
}
