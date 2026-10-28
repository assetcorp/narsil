import type { LifecycleEntry, LifecycleState } from './entry'

export interface ExclusiveContext {
  entryOf(indexName: string): LifecycleEntry
  waitForDrain(entry: LifecycleEntry): Promise<void>
  forget(indexName: string): void
}

async function settledEntry(
  context: ExclusiveContext,
  indexName: string,
  joinsDrop: boolean,
): Promise<LifecycleEntry | null> {
  let entry = context.entryOf(indexName)
  while (true) {
    if (joinsDrop && entry.dropPromise !== null) {
      await entry.dropPromise
      return null
    }
    const pending = entry.dropPromise ?? entry.replacePromise ?? entry.reopenPromise ?? entry.closePromise
    if (pending === null) return entry
    await pending.catch(() => undefined)
    entry = context.entryOf(indexName)
  }
}

function runExclusive(
  context: ExclusiveContext,
  entry: LifecycleEntry,
  slot: 'dropPromise' | 'replacePromise',
  body: () => Promise<void>,
  settle: (succeeded: boolean, previous: LifecycleState) => void,
): Promise<void> {
  const previous = entry.state
  entry.state = slot === 'dropPromise' ? 'dropping' : 'replacing'
  const run = (async () => {
    await context.waitForDrain(entry)
    await body()
  })()
    .then(
      () => settle(true, previous),
      error => {
        settle(false, previous)
        throw error
      },
    )
    .finally(() => {
      entry[slot] = null
    })
  entry[slot] = run
  return run
}

export async function dropExclusively(
  context: ExclusiveContext,
  indexName: string,
  action: () => Promise<void>,
): Promise<void> {
  const entry = await settledEntry(context, indexName, true)
  if (entry === null) return
  await runExclusive(context, entry, 'dropPromise', action, (succeeded, previous) => {
    if (succeeded) context.forget(indexName)
    else entry.state = previous
  })
}

export function replaceUnregistered(
  context: ExclusiveContext,
  indexName: string,
  entry: LifecycleEntry,
  action: () => Promise<void>,
): Promise<void> {
  return runExclusive(context, entry, 'replacePromise', action, succeeded => {
    if (!succeeded) {
      context.forget(indexName)
      return
    }
    entry.state = 'open'
    entry.lastAccessAt = Date.now()
  })
}

export async function replaceExclusively(
  context: ExclusiveContext,
  indexName: string,
  action: (wasOpen: boolean) => Promise<void>,
): Promise<void> {
  const entry = await settledEntry(context, indexName, false)
  if (entry === null) return
  const wasOpen = entry.state === 'open'
  await runExclusive(
    context,
    entry,
    'replacePromise',
    () => action(wasOpen),
    (succeeded, previous) => {
      if (!succeeded) {
        entry.state = previous
        return
      }
      entry.state = 'open'
      entry.cachedError = null
      entry.reopenFailures = 0
      entry.nextReopenAt = 0
      entry.lastAccessAt = Date.now()
    },
  )
}
