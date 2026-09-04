import { describe, expect, it } from 'vitest'
import { dropIdleCopies, noteAccess } from '../../../engine/orchestration/idle'
import { COPY_RESTART_REASON, handleWorkerCrash, POOL_RESTART_DELAY_MS } from '../../../engine/orchestration/repair'
import { replicateToWorkers } from '../../../engine/orchestration/replication'
import { copiesAllowed, scaleOutBeforeBatch, scaleOutIndex } from '../../../engine/orchestration/scale-out'
import { searchViaWorker } from '../../../engine/orchestration/search'
import type { CopyTransition, OrchestratorState } from '../../../engine/orchestration/types'
import { getLanguage } from '../../../languages/registry'
import type { PartitionManager } from '../../../partitioning/manager'
import type { Executor } from '../../../workers/executor'
import { createWorkerPool, type WorkerPool } from '../../../workers/pool'
import type { WorkerAction } from '../../../workers/protocol'
import { emptyOrchestratorState, type OrchestratorHarness, recordingHarness, settle } from './fixtures'

function registryWith(indexName: string): OrchestratorState['indexRegistry'] {
  return new Map([
    [
      indexName,
      { config: { schema: { title: 'string' as const } }, language: getLanguage('english'), embeddingAdapter: null },
    ],
  ])
}

function pendingTransition(kind: CopyTransition['kind']): CopyTransition {
  return { kind, done: new Promise<void>(() => undefined) }
}

async function outcomeOf(work: Promise<void>): Promise<'settled' | 'pending'> {
  return Promise.race([work.then(() => 'settled' as const), settle().then(() => 'pending' as const)])
}

async function driveUntil(harness: OrchestratorHarness, done: () => boolean): Promise<void> {
  for (let round = 0; round < 50 && !done(); round++) {
    await settle()
    harness.releaseAll()
  }
  await settle()
}

describe('scaleOutBeforeBatch', () => {
  it('waits for copies that a threshold load is bringing up', async () => {
    const state = emptyOrchestratorState({ workersEnabled: true })
    state.copyTransitions.set('prose', pendingTransition('load'))

    expect(await outcomeOf(scaleOutBeforeBatch(state, 'prose', 10))).toBe('pending')
  })

  it('lets the batch run on the main copy while copies reload after an idle spell', async () => {
    const state = emptyOrchestratorState({ workersEnabled: true })
    state.copyTransitions.set('prose', pendingTransition('reload'))

    expect(await outcomeOf(scaleOutBeforeBatch(state, 'prose', 10))).toBe('settled')
  })

  it('lets the batch run while an idle drop is in flight', async () => {
    const state = emptyOrchestratorState({ workersEnabled: true })
    state.copyTransitions.set('prose', pendingTransition('drop'))

    expect(await outcomeOf(scaleOutBeforeBatch(state, 'prose', 10))).toBe('settled')
  })
})

describe('an access that arrives while an idle drop is in flight', () => {
  it('queues the reload behind the drop and loads the copies once the drop finishes', async () => {
    const harness = recordingHarness(2, ['prose'], 1, {
      indexRegistry: registryWith('prose'),
      copyIdleTimeoutMs: 1,
    })
    const { state } = harness
    state.lastAccessAt.set('prose', 0)

    const dropping = dropIdleCopies(state, 'prose')
    await settle()
    expect(harness.dispatched.map(entry => entry.action.type)).toEqual(['dropIndex', 'dropIndex'])
    expect(state.copyTransitions.get('prose')?.kind).toBe('drop')

    noteAccess(state, 'prose')
    expect(state.copyTransitions.get('prose')?.kind).toBe('reload')

    await driveUntil(harness, () => !state.copyTransitions.has('prose'))
    await dropping

    expect(state.scaledOutIndexes.has('prose')).toBe(true)
    expect(state.droppedCopies.has('prose')).toBe(false)
    expect(state.copyReloadCounts.get('prose')).toBe(1)
    expect(harness.dispatched.map(entry => entry.action.type)).toEqual([])
  })

  it('joins a reload that an earlier access already queued', async () => {
    const harness = recordingHarness(2, ['prose'], 1, {
      indexRegistry: registryWith('prose'),
      copyIdleTimeoutMs: 1,
    })
    const { state } = harness
    state.lastAccessAt.set('prose', 0)

    const dropping = dropIdleCopies(state, 'prose')
    await settle()
    noteAccess(state, 'prose')
    const queued = state.copyTransitions.get('prose')
    noteAccess(state, 'prose')
    expect(state.copyTransitions.get('prose')).toBe(queued)

    await driveUntil(harness, () => !state.copyTransitions.has('prose'))
    await dropping
    expect(state.copyReloadCounts.get('prose')).toBe(1)
  })
})

describe('a pool whose every worker has crashed', () => {
  function crashablePool(state: OrchestratorState): { pool: WorkerPool; deaths: Array<(error: Error) => void> } {
    const deaths: Array<(error: Error) => void> = []
    const executor: Executor = {
      execute: <T>(): Promise<T> => Promise.resolve(undefined as T),
      shutdown: () => Promise.resolve(),
    }
    const pool: WorkerPool = createWorkerPool({
      count: 2,
      workerFactory: (_workerId, onDeath) => {
        if (onDeath) deaths.push(onDeath)
        return executor
      },
      onWorkerCrash: (workerId, indexNames, error) => handleWorkerCrash(state, pool, workerId, indexNames, error),
    })
    pool.spawnAll()
    pool.addIndexToAll('prose')
    state.workerPool = pool
    return { pool, deaths }
  }

  it('keeps the pool while one worker survives', () => {
    const state = emptyOrchestratorState({ workersEnabled: true, scaledOutIndexes: new Set(['prose']) })
    const { pool, deaths } = crashablePool(state)

    deaths[0](new Error('worker 0 died'))

    expect(state.workerPool).toBe(pool)
    expect(state.scaledOutIndexes.has('prose')).toBe(true)
    expect(copiesAllowed(state)).toBe(true)
  })

  it('retires the pool, marks every index for a reload, and waits before the next start', () => {
    const crashes: number[] = []
    const state = emptyOrchestratorState({
      workersEnabled: true,
      scaledOutIndexes: new Set(['prose']),
      callbacks: { onWorkerCrash: workerId => crashes.push(workerId) },
    })
    const { deaths } = crashablePool(state)
    const before = Date.now()

    deaths[0](new Error('worker 0 died'))
    deaths[1](new Error('worker 1 died'))

    expect(crashes).toEqual([0, 1])
    expect(state.workerPool).toBeNull()
    expect(state.scaledOutIndexes.size).toBe(0)
    expect(state.droppedCopies.get('prose')).toBe(COPY_RESTART_REASON)
    expect(state.poolRetryAt).toBeGreaterThanOrEqual(before + POOL_RESTART_DELAY_MS)
    expect(state.poolRetryDelayMs).toBe(POOL_RESTART_DELAY_MS * 2)
    expect(copiesAllowed(state)).toBe(false)

    state.poolRetryAt = Date.now() - 1
    expect(copiesAllowed(state)).toBe(true)
  })

  it('doubles the delay on each retirement until it reaches a minute', () => {
    const state = emptyOrchestratorState({ workersEnabled: true })
    for (let round = 0; round < 8; round++) {
      const { deaths } = crashablePool(state)
      deaths[0](new Error('died'))
      deaths[1](new Error('died'))
    }
    expect(state.poolRetryDelayMs).toBe(60_000)
  })

  it('reports nothing and starts nothing on an access before the delay passes', () => {
    const state = emptyOrchestratorState({ workersEnabled: true, indexRegistry: registryWith('prose') })
    const { deaths } = crashablePool(state)
    deaths[0](new Error('died'))
    deaths[1](new Error('died'))

    noteAccess(state, 'prose')

    expect(state.copyTransitions.has('prose')).toBe(false)
  })
})

describe('a crashed worker is replaced', () => {
  interface Sent {
    workerId: number
    action: WorkerAction
    resolve: () => void
    reject: (error: Error) => void
  }

  interface RepairablePool {
    sent: Sent[]
    kill: (workerId: number) => void
  }

  function poolUnderRepair(state: OrchestratorState): RepairablePool {
    const sent: Sent[] = []
    const deaths = new Map<number, (error: Error) => void>()
    const pool: WorkerPool = createWorkerPool({
      count: 2,
      workerFactory: (workerId, onDeath) => {
        if (onDeath) deaths.set(workerId, onDeath)
        return {
          execute<T>(action: WorkerAction): Promise<T> {
            return new Promise((resolve, reject) => {
              sent.push({ workerId, action, resolve: () => resolve(undefined as T), reject })
            })
          },
          shutdown: () => Promise.resolve(),
        }
      },
      onWorkerCrash: (workerId, indexNames, error) => handleWorkerCrash(state, pool, workerId, indexNames, error),
    })
    pool.spawnAll()
    pool.addIndexToAll('prose')
    state.workerPool = pool
    return {
      sent,
      kill(workerId: number): void {
        const error = new Error(`worker ${workerId} died`)
        for (const entry of sent.filter(candidate => candidate.workerId === workerId)) {
          sent.splice(sent.indexOf(entry), 1)
          entry.reject(error)
        }
        deaths.get(workerId)?.(error)
      },
    }
  }

  function repairableState(): OrchestratorState {
    return emptyOrchestratorState({
      workersEnabled: true,
      scaledOutIndexes: new Set(['prose']),
      indexRegistry: registryWith('prose'),
      poolRetryDelayMs: 1,
      executor: {
        ...emptyOrchestratorState().executor,
        getManager: () =>
          ({
            partitionCount: 1,
            countDocuments: () => 0,
            getPartition: () => ({}),
            serializePartition: (partitionId: number) => ({ partitionId }),
          }) as unknown as PartitionManager,
      },
    })
  }

  function release(sent: Sent[], type: WorkerAction['type']): Sent[] {
    const matching = sent.filter(entry => entry.action.type === type)
    for (const entry of matching) {
      sent.splice(sent.indexOf(entry), 1)
      entry.resolve()
    }
    return matching
  }

  async function untilSent(sent: Sent[], type: WorkerAction['type']): Promise<void> {
    for (let round = 0; round < 100; round++) {
      if (sent.some(entry => entry.action.type === type)) return
      await settle()
    }
    throw new Error(`No ${type} action reached a worker`)
  }

  function fail(sent: Sent[], type: WorkerAction['type'], error: Error): void {
    for (const entry of sent.filter(candidate => candidate.action.type === type)) {
      sent.splice(sent.indexOf(entry), 1)
      entry.reject(error)
    }
  }

  it('loads every copy onto the replacement, holds its writes until then, and serves from it afterwards', async () => {
    const state = repairableState()
    const { sent, kill } = poolUnderRepair(state)
    const pool = state.workerPool
    if (pool === null) throw new Error('pool missing')

    kill(0)
    const survivors = pool.leaseIdle(2)
    expect(survivors.map(lease => lease.workerId)).toEqual([1])
    for (const lease of survivors) lease.release()
    await untilSent(sent, 'dropIndex')
    expect(state.poolRepair).not.toBeNull()

    expect(release(sent, 'dropIndex').map(entry => entry.workerId)).toEqual([0])
    await settle()
    expect(state.copyLoadBuffers.has('prose')).toBe(true)
    expect(await searchViaWorker(state, 'prose', { term: 'a' })).toBeNull()

    await replicateToWorkers(state, {
      type: 'insert',
      indexName: 'prose',
      docId: 'late',
      document: { id: 'late' },
      requestId: 'replicate-insert-late',
    })
    expect(sent.map(entry => entry.action.type)).toEqual(['createIndex'])

    expect(release(sent, 'createIndex').map(entry => entry.workerId)).toEqual([0])
    await settle()
    expect(release(sent, 'deserialize').map(entry => entry.workerId)).toEqual([0])
    await state.poolRepair
    await settle()

    const inserts = sent.filter(entry => entry.action.type === 'insert')
    expect(inserts.map(entry => entry.workerId).sort()).toEqual([0, 1])
    expect(sent).toHaveLength(2)
    expect(
      pool
        .leaseIdle(2)
        .map(lease => lease.workerId)
        .sort(),
    ).toEqual([0, 1])
    expect(pool.deadWorkerIds()).toEqual([])
    expect(state.poolRetryDelayMs).toBe(POOL_RESTART_DELAY_MS)
  })

  it('abandons a replacement that dies while it loads and schedules another attempt with a longer delay', async () => {
    const state = repairableState()
    const { sent, kill } = poolUnderRepair(state)
    const pool = state.workerPool
    if (pool === null) throw new Error('pool missing')

    kill(0)
    await untilSent(sent, 'dropIndex')
    const [drop] = release(sent, 'dropIndex')
    expect(drop.workerId).toBe(0)
    await settle()
    expect(sent.map(entry => entry.action.type)).toEqual(['createIndex'])

    kill(0)
    await state.poolRepair
    await settle()

    expect(state.copyLoadBuffers.has('prose')).toBe(false)
    expect(pool.deadWorkerIds()).toEqual([0])
    const survivors = pool.leaseIdle(2)
    expect(survivors.map(lease => lease.workerId)).toEqual([1])
    for (const lease of survivors) lease.release()
    expect(state.repairTimer).not.toBeNull()
    expect(state.poolRetryDelayMs).toBe(2)
    if (state.repairTimer !== null) clearTimeout(state.repairTimer)
  })

  it('leaves the buffer a later load installed while the replacement was still loading', async () => {
    const state = repairableState()
    const { sent, kill } = poolUnderRepair(state)

    kill(0)
    await untilSent(sent, 'dropIndex')
    release(sent, 'dropIndex')
    await untilSent(sent, 'createIndex')

    const laterBuffer: WorkerAction[] = []
    state.copyLoadBuffers.set('prose', laterBuffer)
    kill(0)
    await state.poolRepair
    await settle()

    expect(state.copyLoadBuffers.get('prose')).toBe(laterBuffer)
  })

  it('keeps the reload reason where the load after a restart fails', async () => {
    const state = repairableState()
    state.scaledOutIndexes.delete('prose')
    state.droppedCopies.set('prose', COPY_RESTART_REASON)
    const { sent } = poolUnderRepair(state)

    const load = scaleOutIndex(state, 'prose', COPY_RESTART_REASON)
    await untilSent(sent, 'dropIndex')
    release(sent, 'dropIndex')
    await untilSent(sent, 'createIndex')
    fail(sent, 'createIndex', new Error('the worker refused the index'))
    await load

    expect(state.droppedCopies.get('prose')).toBe(COPY_RESTART_REASON)
    expect(state.scaledOutIndexes.has('prose')).toBe(false)
    expect(state.copyLoadBuffers.has('prose')).toBe(false)
  })
})
