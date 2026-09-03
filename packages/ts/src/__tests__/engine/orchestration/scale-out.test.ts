import { describe, expect, it } from 'vitest'
import { dropIdleCopies, noteAccess } from '../../../engine/orchestration/idle'
import {
  COPY_RESTART_REASON,
  copiesAllowed,
  handleWorkerCrash,
  POOL_RESTART_DELAY_MS,
  scaleOutBeforeBatch,
} from '../../../engine/orchestration/scale-out'
import type { CopyTransition, OrchestratorState } from '../../../engine/orchestration/types'
import { getLanguage } from '../../../languages/registry'
import type { Executor } from '../../../workers/executor'
import { createWorkerPool, type WorkerPool } from '../../../workers/pool'
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
