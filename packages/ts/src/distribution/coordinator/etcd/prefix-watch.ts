import type { Etcd3 as Etcd3Client, IKeyValue } from 'etcd3'
import { ErrorCodes, NarsilError } from '../../../errors'
import { RECONNECT_FIRST_DELAY_MS, RECONNECT_LONGEST_DELAY_MS } from './constants'
import type { ReplaceableWatchClient } from './watch-client'
import { WatchAttachError, type WatchStream, type WatchStreams } from './watch-stream'

export interface PrefixWatchContext {
  client: Etcd3Client
  watchClient: ReplaceableWatchClient
  streams: WatchStreams
  reportHandlerError(error: unknown): void
}

export interface PrefixWatchHandlers {
  put(kv: IKeyValue): void
  delete(fullKey: string): void
}

function blamesTheConnection(error: unknown): boolean {
  return error instanceof WatchAttachError || !(error instanceof NarsilError)
}

export function watchPrefix(
  context: PrefixWatchContext,
  prefix: string,
  handlers: PrefixWatchHandlers,
): Promise<() => void> {
  const { streams } = context
  if (streams.isClosed()) {
    return Promise.reject(new NarsilError(ErrorCodes.CONFIG_INVALID, 'Coordinator has been shut down'))
  }
  const modRevisionByKey = new Map<string, string>()
  let current: WatchStream | null = null
  let stopped = false
  let reopenTimer: ReturnType<typeof setTimeout> | null = null
  let reopenDelayMs = RECONNECT_FIRST_DELAY_MS

  function inactive(): boolean {
    return stopped || streams.isClosed()
  }

  function recordPut(kv: IKeyValue): void {
    modRevisionByKey.set(kv.key.toString(), kv.mod_revision)
    handlers.put(kv)
  }

  function recordDelete(fullKey: string): void {
    modRevisionByKey.delete(fullKey)
    handlers.delete(fullKey)
  }

  function reportingHandlerErrors(record: () => void): void {
    try {
      record()
    } catch (error) {
      context.reportHandlerError(error)
    }
  }

  async function listMissedChanges(reportMissedChanges: boolean): Promise<string> {
    const listing = await context.client.getAll().prefix(prefix).exec()
    const listedKeys = new Set<string>()
    for (const kv of listing.kvs) {
      const fullKey = kv.key.toString()
      listedKeys.add(fullKey)
      if (!reportMissedChanges) {
        modRevisionByKey.set(fullKey, kv.mod_revision)
      } else if (modRevisionByKey.get(fullKey) !== kv.mod_revision) {
        reportingHandlerErrors(() => recordPut(kv))
      }
    }
    if (reportMissedChanges) {
      for (const fullKey of [...modRevisionByKey.keys()]) {
        if (!listedKeys.has(fullKey)) reportingHandlerErrors(() => recordDelete(fullKey))
      }
    }
    return String(BigInt(listing.header.revision) + 1n)
  }

  async function watchFrom(startRevision: string): Promise<void> {
    const client = context.watchClient.current()
    let opened: WatchStream | null = null
    let lostWhileOpening = false
    let watch: WatchStream
    try {
      watch = await streams.open(client, prefix, startRevision, {
        put: recordPut,
        delete: kv => recordDelete(kv.key.toString()),
        handlerFailed: context.reportHandlerError,
        lost() {
          if (opened === null) lostWhileOpening = true
          else reopenAfterFailure(opened)
        },
      })
    } catch (error) {
      if (!streams.isClosed() && blamesTheConnection(error)) context.watchClient.replace(client)
      throw error
    }
    if (inactive()) {
      await watch.close()
      return
    }
    opened = watch
    current = watch
    if (lostWhileOpening) reopenAfterFailure(watch)
  }

  async function listThenWatch(reportMissedChanges: boolean): Promise<void> {
    await watchFrom(await listMissedChanges(reportMissedChanges))
  }

  function scheduleReopen(): void {
    if (inactive()) return
    const delayMs = reopenDelayMs
    reopenDelayMs = Math.min(reopenDelayMs * 2, RECONNECT_LONGEST_DELAY_MS)
    reopenTimer = setTimeout(() => {
      reopenTimer = null
      if (inactive()) return
      streams.track(listThenWatch(true)).then(
        () => {
          reopenDelayMs = RECONNECT_FIRST_DELAY_MS
        },
        () => scheduleReopen(),
      )
    }, delayMs)
    reopenTimer.unref?.()
  }

  function reopenAfterFailure(failed: WatchStream): void {
    if (current !== failed) return
    current = null
    void failed.close()
    scheduleReopen()
  }

  async function start(): Promise<() => void> {
    const startRevision = await listMissedChanges(false)
    try {
      await watchFrom(startRevision)
    } catch (_) {
      scheduleReopen()
    }
    return () => {
      stopped = true
      if (reopenTimer !== null) {
        clearTimeout(reopenTimer)
        reopenTimer = null
      }
      if (current !== null) {
        void current.close()
        current = null
      }
    }
  }

  return streams.track(start())
}
