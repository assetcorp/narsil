import type { NarsilConfig } from '../../types/config'
import { DEFAULT_COPY_IDLE_TIMEOUT_MS } from './constants'
import type { IndexRegistry, WorkerOrchestrator } from './types'

export function createLocalOrchestrator(config: NarsilConfig | undefined, indexes: IndexRegistry): WorkerOrchestrator {
  let mainCopyQueries = config?.workers?.mainCopyQueries
  const closeAfter = config?.lifecycle?.idleTimeoutMs
  const idleTimeout = config?.workers?.idleTimeoutMs ?? Math.min(DEFAULT_COPY_IDLE_TIMEOUT_MS, closeAfter ?? Infinity)
  const settled = (): Promise<void> => Promise.resolve()
  const unchanged = (): void => undefined
  return {
    scaleOutReadyIndexes: settled,
    scaleOutBeforeBatch: settled,
    replicateToWorkers: settled,
    publishToWorkers: () => undefined,
    settlePublications: () => undefined,
    awaitReplication: settled,
    queueDiskAdoption: unchanged,
    awaitWrites: settled,
    awaitCompactions: settled,
    openIndex: settled,
    closeIndex: settled,
    isIndexBusy: () => false,
    buildSegments: () => Promise.resolve(null),
    segmentBuildConcurrency: () => 0,
    searchViaWorker: () => Promise.resolve(null),
    hasWorkerPool: () => false,
    mainCopyQueries: () => mainCopyQueries ?? 'lone',
    shareMainThread() {
      mainCopyQueries ??= 'none'
    },
    serveRequestsOnWorkers: () => Promise.resolve(0),
    requestThreadCount: () => 0,
    copyIdleTimeoutMs: () => idleTimeout,
    stopRequestThreads: unchanged,
    desyncIndex: () => false,
    releaseIndexCopies: () => Promise.resolve(false),
    endCopyRelease: settled,
    resyncIndex: settled,
    noteAccess: unchanged,
    workerCopies: () => [...indexes.keys()].map(indexName => ({ indexName, scaledOut: false, reloadCount: 0 })),
    getWorkerMemoryStats: () => Promise.resolve([]),
    shutdown: settled,
  }
}
