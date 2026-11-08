import { createNarsilClient } from '../../client/client'
import type { RequestOptions } from '../../client/options'
import { ErrorCodes, NarsilError } from '../../errors'
import { encodeDocument } from '../../serialization/document-encoding'
import { decode } from '../../serialization/msgpack'
import type { AnyDocument } from '../../types/schema'
import { SYNC_CLOSE_CREDENTIAL_EXPIRED, SYNC_CLOSE_RESYNC } from '../protocol'
import { RECONNECT_MIN_DELAY_MS, RETRY_MAX_DELAY_MS, SNAPSHOT_RETRY_DELAY_MS } from './constants'
import { backoffDelayMs, createChanges, type DeviceContext } from './context'
import { feedUrlOf } from './feed'
import { putLocally, removeLocally } from './local-writes'
import { createProgress } from './progress'
import { QueueMirror } from './queue'
import { createSession, type SessionState } from './session'
import { downloadPublishedSnapshot, restoreDownloadedSnapshot, type SnapshotContext } from './snapshot'
import { createSerial } from './stores/serial'
import type { DeviceSync, DeviceSyncOptions, DeviceSyncStatus } from './types'
import { createUploader } from './uploader'

export type {
  DevicePosition,
  DeviceSync,
  DeviceSyncOptions,
  DeviceSyncStatus,
  DeviceSyncStore,
  KeptEntry,
  QueuedWrite,
  RefusedWrite,
  SavedDownload,
  SnapshotMemoryCheck,
  UploadOutcome,
} from './types'

function invalid(message: string): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, message)
}

function validated(options: DeviceSyncOptions): void {
  if (typeof options.indexName !== 'string' || options.indexName.length === 0) {
    throw invalid('Device sync needs an index name')
  }
  const limit = options.replayLimitOfSnapshot
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
    throw invalid('replayLimitOfSnapshot must be a finite number at or above 0')
  }
}

function copyOf(document: AnyDocument): AnyDocument {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'A document must be an object')
  }
  return decode(encodeDocument(document)) as AnyDocument
}

function requireDocumentId(documentId: string): void {
  if (typeof documentId !== 'string' || documentId.length === 0) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'A document ID must be a non-empty string')
  }
}

/**
 * Keeps one index on a device in step with a server that has device sync on for that index.
 *
 * Local writes through {@link DeviceSync.put} and {@link DeviceSync.remove} reach the device's index at once and wait
 * in the store's queue until the server accepts them, so they work offline. The device reads every later change from
 * the server's feed, and it loads the server's published snapshot where it holds no copy or falls too far behind.
 *
 * @param options - The engine, the index, the server, and the store.
 * @returns The device sync, which does nothing until {@link DeviceSync.start}.
 * @throws A `NarsilError` with `CONFIG_INVALID` when the index name, the URL, or the replay limit is invalid.
 * @public
 */
export function createDeviceSync(options: DeviceSyncOptions): DeviceSync {
  validated(options)
  const { engine, indexName, store } = options
  const feedUrl = feedUrlOf(options.url, indexName)
  const client = createNarsilClient({ url: options.url })
  const changes = createChanges()
  let stopped = true
  let recovered: Promise<void> | null = null
  let loop: Promise<void> | null = null
  let appChoseLoad = false
  let snapshotDeferred = false
  let aborts = new AbortController()

  async function credential(): Promise<string | null> {
    return options.credential === undefined ? null : await options.credential()
  }

  const context: DeviceContext = {
    options,
    engine,
    indexName,
    store,
    client,
    work: createSerial(),
    queue: new QueueMirror(),
    changes,
    report(error) {
      try {
        options.onError?.(error)
      } catch {}
    },
    credential,
    async requestOptions(): Promise<RequestOptions> {
      const value = await credential()
      const signal = aborts.signal
      return value === null ? { signal } : { signal, headers: { authorization: `Bearer ${value}` } }
    },
    makeDurable: options.makeDurable ?? (() => engine.checkpoint(indexName)),
    stopped: () => stopped,
    pause(delayMs) {
      return new Promise(resolve => {
        if (stopped) {
          resolve()
          return
        }
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, delayMs)
        const watch = (): void => {
          if (done) return
          if (stopped) finish()
          else changes.next().then(watch)
        }
        changes.next().then(watch)
      })
    },
  }
  const progress = createProgress(context)
  const state: SessionState = {
    subscribed: false,
    needsSnapshot: null,
    replayAnyway: false,
    pendingHold: [],
    settings: null,
  }
  const session = createSession(context, progress, state)
  const uploader = createUploader(context, progress, session, state)

  async function loadSnapshot(): Promise<'loaded' | 'kept'> {
    const snapshotContext: SnapshotContext = {
      engine,
      indexName,
      client,
      store,
      requestOptions: context.requestOptions,
      chooseSnapshotLoad: options.chooseSnapshotLoad ?? (async () => 'load'),
      settings: state.settings,
      appChoseLoad,
    }
    const downloaded = await downloadPublishedSnapshot(snapshotContext)
    if (downloaded.kind === 'kept') return 'kept'
    await context.work.run(async () => {
      const position = await restoreDownloadedSnapshot(snapshotContext, downloaded)
      session.forgetAppliedSettings()
      await progress.adopt(position)
    })
    return 'loaded'
  }

  async function snapshotStep(attempt: number): Promise<number> {
    if (snapshotDeferred && !appChoseLoad) {
      await changes.next()
      return attempt
    }
    try {
      const outcome = await loadSnapshot()
      if (outcome === 'loaded') {
        state.needsSnapshot = null
        appChoseLoad = false
        snapshotDeferred = false
      } else if (state.needsSnapshot === 'behind' && progress.position() !== null) {
        state.needsSnapshot = null
        state.replayAnyway = true
      } else {
        snapshotDeferred = true
      }
      changes.notify()
      return 0
    } catch (error) {
      context.report(error)
      await context.pause(backoffDelayMs(attempt, SNAPSHOT_RETRY_DELAY_MS, RETRY_MAX_DELAY_MS))
      return attempt + 1
    }
  }

  async function run(): Promise<void> {
    let attempt = 0
    while (!stopped) {
      if (progress.position() === null || state.needsSnapshot !== null) {
        attempt = await snapshotStep(attempt)
        continue
      }
      const { code, subscribed } = await session.connect(feedUrl)
      if (stopped) return
      if (subscribed) attempt = 0
      if (code === SYNC_CLOSE_RESYNC) state.needsSnapshot ??= 'required'
      if (code === SYNC_CLOSE_CREDENTIAL_EXPIRED || state.needsSnapshot !== null) continue
      await context.pause(backoffDelayMs(attempt, RECONNECT_MIN_DELAY_MS, RETRY_MAX_DELAY_MS))
      attempt += 1
    }
  }

  async function waitUntil(condition: () => boolean): Promise<void> {
    while (!condition()) {
      if (stopped) throw invalid('Device sync stopped before it settled')
      await changes.next()
    }
  }

  function requireRecovered(): Promise<void> {
    if (recovered === null) throw invalid('Call start before writing through device sync')
    return recovered
  }

  async function write(documentId: string, document: AnyDocument | null): Promise<void> {
    requireDocumentId(documentId)
    const copy = document === null ? null : copyOf(document)
    await requireRecovered()
    await context.work.run(async () => {
      const queued = await store.appendWrite({ documentId, document: copy })
      context.queue.add(queued)
      try {
        if (copy === null) await removeLocally(engine, indexName, documentId)
        else await putLocally(engine, indexName, documentId, copy)
      } catch (error) {
        await store.removeWrites([queued.sequence])
        context.queue.remove([queued.sequence])
        throw error
      }
    })
    changes.notify()
    uploader.kick()
  }

  function quiet(): boolean {
    return (
      state.subscribed &&
      context.queue.size === 0 &&
      state.pendingHold.length === 0 &&
      !session.holding() &&
      state.needsSnapshot === null
    )
  }

  return {
    put: (documentId, document) => write(documentId, document),
    remove: documentId => write(documentId, null),

    async start() {
      if (!stopped) return
      stopped = false
      aborts = new AbortController()
      recovered ??= progress.recover()
      try {
        await recovered
      } catch (error) {
        recovered = null
        stopped = true
        throw error
      }
      loop = run().catch(context.report)
      uploader.kick()
    },

    async stop() {
      if (stopped) return
      stopped = true
      aborts.abort()
      session.close('stopped')
      progress.cancelFlush()
      changes.notify()
      await Promise.allSettled([loop, uploader.idle()])
      loop = null
      if (progress.unsavedBytes() > 0) await progress.save().catch(context.report)
    },

    async loadSnapshot() {
      appChoseLoad = true
      state.needsSnapshot ??= 'required'
      session.close('snapshot')
      changes.notify()
      await waitUntil(() => !appChoseLoad && state.needsSnapshot === null)
    },

    async settled() {
      for (;;) {
        await waitUntil(quiet)
        const heads = await session.requestHeads()
        if (heads === null) continue
        await waitUntil(() => progress.reached(heads) || !state.subscribed)
        if (!progress.reached(heads)) continue
        await progress.save()
        if (quiet()) return
      }
    },

    status(): DeviceSyncStatus {
      const position = progress.position()
      return {
        connection: stopped ? 'stopped' : state.subscribed ? 'connected' : 'connecting',
        queuedWrites: context.queue.size,
        position: position === null ? null : { epoch: position.epoch, seqNos: [...position.seqNos] },
        snapshotDeferred,
      }
    },
  }
}
