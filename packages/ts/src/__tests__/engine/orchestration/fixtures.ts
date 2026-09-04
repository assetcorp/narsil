import type { OrchestratorState } from '../../../engine/orchestration/types'
import type { PartitionManager } from '../../../partitioning/manager'
import type { Executor } from '../../../workers/executor'
import { createWorkerPool } from '../../../workers/pool'
import type { WorkerAction } from '../../../workers/protocol'

export interface RecordedDispatch {
  workerId: number
  action: WorkerAction
  resolve: (value?: unknown) => void
  reject: (reason: Error) => void
}

export interface OrchestratorHarness {
  state: OrchestratorState
  dispatched: RecordedDispatch[]
  releaseAll: () => void
}

export function emptyOrchestratorState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    config: undefined,
    executor: {
      execute<T>(): Promise<T> {
        return Promise.resolve(undefined) as Promise<T>
      },
      shutdown: () => Promise.resolve(),
      getManager: () => undefined,
      createIndex: () => undefined,
      dropIndex: () => undefined,
      listIndexes: () => [],
    },
    indexRegistry: new Map(),
    callbacks: undefined,
    workersEnabled: false,
    keywordWorkerCount: 1,
    copyThreshold: 1_000,
    copyIdleTimeoutMs: 300_000,
    bootstrapModule: undefined,
    reportedIneligible: new Set(),
    scaledOutIndexes: new Set(),
    desyncedIndexes: new Set(),
    copyLoadBuffers: new Map(),
    copyTransitions: new Map(),
    droppedCopies: new Map(),
    lastAccessAt: new Map(),
    copyReloadCounts: new Map(),
    replicationQueues: new Map(),
    segmentLedger: new Map(),
    compactionsInFlight: new Map(),
    idleMergeTimers: new Map(),
    workerPool: null,
    poolStart: null,
    poolRetryAt: 0,
    poolRetryDelayMs: 1_000,
    poolRepair: null,
    mainCopyTurnTaken: false,
    repairTimer: null,
    scaleOutBlocked: false,
    idleSweep: null,
    ...overrides,
  }
}

export function recordingHarness(
  workerCount: number,
  indexNames: string[],
  partitionCount = 1,
  overrides: Partial<OrchestratorState> = {},
): OrchestratorHarness {
  const dispatched: RecordedDispatch[] = []

  const workerFactory = (workerId: number): Executor => ({
    execute<T>(action: WorkerAction): Promise<T> {
      return new Promise((resolve, reject) => {
        dispatched.push({ workerId, action, resolve: resolve as (value?: unknown) => void, reject })
      }) as Promise<T>
    },
    shutdown: () => Promise.resolve(),
  })

  const pool = createWorkerPool({ count: workerCount, workerFactory })
  for (const name of indexNames) {
    pool.addIndexToAll(name)
  }

  const state = emptyOrchestratorState({
    executor: {
      execute<T>(): Promise<T> {
        return Promise.resolve(undefined) as Promise<T>
      },
      shutdown: () => Promise.resolve(),
      getManager: () =>
        ({
          partitionCount,
          countDocuments: () => 0,
          getPartition: () => ({}),
          serializePartition: (partitionId: number) => ({ partitionId }),
        }) as unknown as PartitionManager,
      createIndex: () => undefined,
      dropIndex: () => undefined,
      listIndexes: () => indexNames,
    },
    workersEnabled: true,
    keywordWorkerCount: workerCount,
    scaledOutIndexes: new Set(indexNames),
    workerPool: pool,
    ...overrides,
  })

  return {
    state,
    dispatched,
    releaseAll: () => {
      while (dispatched.length > 0) {
        const entry = dispatched.shift()
        if (entry) entry.resolve()
      }
    },
  }
}

export function settle(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}
