import type { InvalidationAdapter, PersistenceAdapter } from '../types/adapters'

export interface FlushManagerConfig {
  persistence: PersistenceAdapter
  invalidation: InvalidationAdapter
  interval?: number
  mutationThreshold?: number
  maxRetries?: number
  baseRetryDelay?: number
  onError?: (indexName: string, partitionId: number, error: Error, retriesExhausted: boolean) => void
}

export interface FlushManager {
  markDirty(indexName: string, partitionId: number): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

const DEFAULT_INTERVAL = 5000
const DEFAULT_MUTATION_THRESHOLD = 1000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_RETRY_DELAY = 100

export function createFlushManager(
  config: FlushManagerConfig,
  getPartitionData: (indexName: string, partitionId: number) => Uint8Array,
  getInstanceId: () => string,
): FlushManager {
  const {
    persistence,
    invalidation,
    interval = DEFAULT_INTERVAL,
    mutationThreshold = DEFAULT_MUTATION_THRESHOLD,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseRetryDelay = DEFAULT_BASE_RETRY_DELAY,
    onError,
  } = config

  const dirtyPartitions = new Map<string, Set<number>>()
  let mutationCount = 0
  let flushTimerId: ReturnType<typeof setTimeout> | null = null
  let isShuttingDown = false
  let flushPromise: Promise<void> | null = null

  function startTimer(): void {
    if (flushTimerId !== null || isShuttingDown) {
      return
    }
    flushTimerId = setInterval(() => {
      flush()
    }, interval)
  }

  function addToDirtySet(indexName: string, partitionId: number): void {
    let partitions = dirtyPartitions.get(indexName)
    if (partitions === undefined) {
      partitions = new Set<number>()
      dirtyPartitions.set(indexName, partitions)
    }
    partitions.add(partitionId)
  }

  function snapshotAndClearDirty(): Map<string, Set<number>> {
    const snapshot = new Map<string, Set<number>>()
    for (const [indexName, partitions] of dirtyPartitions) {
      snapshot.set(indexName, new Set(partitions))
    }
    dirtyPartitions.clear()
    return snapshot
  }

  async function saveWithRetry(indexName: string, partitionId: number): Promise<boolean> {
    const key = `${indexName}/${partitionId}`
    const data = getPartitionData(indexName, partitionId)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await persistence.save(key, data)
        return true
      } catch (err: unknown) {
        const isLastAttempt = attempt === maxRetries - 1
        if (isLastAttempt) {
          onError?.(indexName, partitionId, err as Error, true)
          return false
        }
        const delay = baseRetryDelay * 2 ** attempt * (0.5 + Math.random() * 0.5)
        await new Promise<void>(resolve => setTimeout(resolve, delay))
      }
    }

    return false
  }

  async function performFlush(): Promise<void> {
    const snapshot = snapshotAndClearDirty()

    for (const [indexName, partitions] of snapshot) {
      const succeededPartitions: number[] = []

      for (const partitionId of partitions) {
        const saved = await saveWithRetry(indexName, partitionId)
        if (saved) {
          succeededPartitions.push(partitionId)
        } else {
          addToDirtySet(indexName, partitionId)
        }
      }

      if (succeededPartitions.length > 0) {
        await invalidation.publish({
          type: 'partition',
          indexName,
          partitions: succeededPartitions,
          timestamp: Date.now(),
          sourceInstanceId: getInstanceId(),
        })
      }
    }

    mutationCount = 0
  }

  function flush(): Promise<void> {
    if (flushPromise !== null) {
      return flushPromise
    }

    flushPromise = performFlush().finally(() => {
      flushPromise = null
    })

    return flushPromise
  }

  function markDirty(indexName: string, partitionId: number): void {
    addToDirtySet(indexName, partitionId)
    mutationCount++

    if (mutationCount >= mutationThreshold) {
      flush()
    }

    startTimer()
  }

  async function shutdown(): Promise<void> {
    isShuttingDown = true
    if (flushTimerId !== null) {
      clearInterval(flushTimerId)
      flushTimerId = null
    }
    await flush()
  }

  return {
    markDirty,
    flush,
    shutdown,
  }
}
