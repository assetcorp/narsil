interface OperationTrackerConfig {
  guard(): void
  assertIndex(indexName: string): void
}

export interface ClusterOperationTracker {
  track<T>(indexName: string | null, action: () => Promise<T>): Promise<T>
  transition<T>(indexName: string, action: () => Promise<T>): Promise<T>
  drain(): Promise<void>
}

/**
 * Coordinates cluster operations with exclusive per-index transitions.
 *
 * @param config - Shutdown and index-identity checks for each operation.
 * @returns A tracker that drains one index or the whole node before teardown.
 */
export function createClusterOperationTracker(config: OperationTrackerConfig): ClusterOperationTracker {
  let activeOperations = 0
  let drainResolve: (() => void) | null = null
  const activeByIndex = new Map<string, number>()
  const indexDrainResolvers = new Map<string, Set<() => void>>()
  const transitions = new Map<string, Promise<void>>()

  function releaseIndex(indexName: string): void {
    const remaining = (activeByIndex.get(indexName) ?? 1) - 1
    if (remaining > 0) {
      activeByIndex.set(indexName, remaining)
      return
    }
    activeByIndex.delete(indexName)
    for (const resolve of indexDrainResolvers.get(indexName) ?? []) resolve()
    indexDrainResolvers.delete(indexName)
  }

  async function track<T>(indexName: string | null, action: () => Promise<T>): Promise<T> {
    config.guard()
    if (indexName !== null) config.assertIndex(indexName)
    activeOperations += 1
    let indexCounted = false
    try {
      if (indexName !== null) {
        const transition = transitions.get(indexName)
        if (transition !== undefined) await transition
        config.assertIndex(indexName)
        activeByIndex.set(indexName, (activeByIndex.get(indexName) ?? 0) + 1)
        indexCounted = true
      }
      return await action()
    } finally {
      if (indexName !== null && indexCounted) releaseIndex(indexName)
      activeOperations -= 1
      if (activeOperations === 0 && drainResolve !== null) {
        drainResolve()
        drainResolve = null
      }
    }
  }

  async function waitForIndexDrain(indexName: string): Promise<void> {
    if ((activeByIndex.get(indexName) ?? 0) === 0) return
    await new Promise<void>(resolve => {
      let resolvers = indexDrainResolvers.get(indexName)
      if (resolvers === undefined) {
        resolvers = new Set()
        indexDrainResolvers.set(indexName, resolvers)
      }
      resolvers.add(resolve)
    })
  }

  function transition<T>(indexName: string, action: () => Promise<T>): Promise<T> {
    return track(null, async () => {
      const previous = transitions.get(indexName) ?? Promise.resolve()
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          await waitForIndexDrain(indexName)
          return action()
        })
      const tail = run.then(
        () => undefined,
        () => undefined,
      )
      transitions.set(indexName, tail)
      try {
        return await run
      } finally {
        if (transitions.get(indexName) === tail) transitions.delete(indexName)
      }
    })
  }

  async function drain(): Promise<void> {
    if (activeOperations === 0) return
    await new Promise<void>(resolve => {
      drainResolve = resolve
    })
  }

  return { track, transition, drain }
}
