import type { Etcd3 as Etcd3Client, IKeyValue, Watcher } from 'etcd3'
import { RECONNECT_FIRST_DELAY_MS, RECONNECT_LONGEST_DELAY_MS } from './constants'

export interface PrefixWatchContext {
  client: Etcd3Client
  addWatcher(watcher: Watcher): void
  removeWatcher(watcher: Watcher): void
  isShutdown(): boolean
}

export interface PrefixWatchHandlers {
  put(kv: IKeyValue): void
  delete(fullKey: string): void
}

function connectedOrDropped(watcher: Watcher): Promise<void> {
  return new Promise((resolve, reject) => {
    const onConnected = (): void => {
      detach()
      resolve()
    }
    const onDropped = (error: unknown): void => {
      detach()
      reject(error)
    }
    function detach(): void {
      watcher.off('connected', onConnected)
      watcher.off('disconnected', onDropped)
      watcher.off('error', onDropped)
    }
    watcher.once('connected', onConnected)
    watcher.once('disconnected', onDropped)
    watcher.once('error', onDropped)
  })
}

export async function watchPrefix(
  context: PrefixWatchContext,
  prefix: string,
  handlers: PrefixWatchHandlers,
): Promise<() => void> {
  const modRevisionByKey = new Map<string, string>()
  let current: Watcher | null = null
  let stopped = false
  let reopenTimer: ReturnType<typeof setTimeout> | null = null
  let reopenDelayMs = RECONNECT_FIRST_DELAY_MS

  function recordPut(kv: IKeyValue): void {
    modRevisionByKey.set(kv.key.toString(), kv.mod_revision)
    handlers.put(kv)
  }

  function recordDelete(fullKey: string): void {
    modRevisionByKey.delete(fullKey)
    handlers.delete(fullKey)
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
        recordPut(kv)
      }
    }
    if (reportMissedChanges) {
      for (const fullKey of [...modRevisionByKey.keys()]) {
        if (!listedKeys.has(fullKey)) recordDelete(fullKey)
      }
    }
    return String(BigInt(listing.header.revision) + 1n)
  }

  async function watchFrom(startRevision: string): Promise<void> {
    const watcher = context.client.watch().prefix(prefix).startRevision(startRevision).watcher()
    try {
      await connectedOrDropped(watcher)
    } catch (error) {
      watcher.cancel().catch(() => {})
      throw error
    }
    if (stopped || context.isShutdown()) {
      watcher.cancel().catch(() => {})
      return
    }
    watcher.on('put', recordPut)
    watcher.on('delete', (kv: IKeyValue) => recordDelete(kv.key.toString()))
    watcher.on('error', () => reopenAfterFailure(watcher))
    watcher.on('disconnected', () => reopenAfterFailure(watcher))
    context.addWatcher(watcher)
    current = watcher
  }

  async function listThenWatch(reportMissedChanges: boolean): Promise<void> {
    await watchFrom(await listMissedChanges(reportMissedChanges))
  }

  function scheduleReopen(): void {
    if (stopped || context.isShutdown()) return
    const delayMs = reopenDelayMs
    reopenDelayMs = Math.min(reopenDelayMs * 2, RECONNECT_LONGEST_DELAY_MS)
    reopenTimer = setTimeout(() => {
      reopenTimer = null
      listThenWatch(true).then(
        () => {
          reopenDelayMs = RECONNECT_FIRST_DELAY_MS
        },
        () => scheduleReopen(),
      )
    }, delayMs)
    reopenTimer.unref?.()
  }

  function reopenAfterFailure(failed: Watcher): void {
    if (current !== failed) return
    current = null
    context.removeWatcher(failed)
    scheduleReopen()
  }

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
      context.removeWatcher(current)
      current = null
    }
  }
}
