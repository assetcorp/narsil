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

  async function listThenWatch(reportMissedChanges: boolean): Promise<void> {
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

    const watcher = await context.client
      .watch()
      .prefix(prefix)
      .startRevision(String(BigInt(listing.header.revision) + 1n))
      .create()
    if (stopped || context.isShutdown()) {
      watcher.cancel().catch(() => {})
      return
    }
    watcher.on('put', recordPut)
    watcher.on('delete', (kv: IKeyValue) => recordDelete(kv.key.toString()))
    watcher.on('error', () => reopenAfterFailure(watcher))
    context.addWatcher(watcher)
    current = watcher
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

  await listThenWatch(false)

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
