import type { LifecycleEntry, LifecycleState } from './entry'

export interface ReplaceContext {
  entryOf(indexName: string): LifecycleEntry
  waitForDrain(entry: LifecycleEntry): Promise<void>
  forget(indexName: string): void
}

function runReplacement(
  context: ReplaceContext,
  entry: LifecycleEntry,
  body: () => Promise<void>,
  settle: (succeeded: boolean, previous: LifecycleState) => void,
): Promise<void> {
  const previous = entry.state
  entry.state = 'replacing'
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
      entry.replacePromise = null
    })
  entry.replacePromise = run
  return run
}

export function replaceUnregistered(
  context: ReplaceContext,
  indexName: string,
  entry: LifecycleEntry,
  action: () => Promise<void>,
): Promise<void> {
  return runReplacement(context, entry, action, succeeded => {
    if (!succeeded) {
      context.forget(indexName)
      return
    }
    entry.state = 'open'
    entry.lastAccessAt = Date.now()
  })
}

export async function replaceExclusively(
  context: ReplaceContext,
  indexName: string,
  action: (wasOpen: boolean) => Promise<void>,
): Promise<void> {
  let entry = context.entryOf(indexName)
  while (true) {
    const pending = entry.dropPromise ?? entry.replacePromise ?? entry.reopenPromise ?? entry.closePromise
    if (pending === null) break
    await pending.catch(() => undefined)
    entry = context.entryOf(indexName)
  }
  const wasOpen = entry.state === 'open'
  await runReplacement(
    context,
    entry,
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
