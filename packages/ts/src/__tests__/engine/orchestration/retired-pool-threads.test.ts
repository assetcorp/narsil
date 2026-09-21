import { beforeEach, describe, expect, it, vi } from 'vitest'

const started = vi.hoisted(() => ({ threads: 0 }))

vi.mock('#platform/worker-factory', () => ({
  createWorkerFactory: async () => () => {
    started.threads += 1
    return {
      execute: <T>(): Promise<T> => Promise.resolve(undefined as T),
      shutdown: () => Promise.resolve(),
    }
  },
}))

import { RETIRED_THREADS_EXIT_WAIT_MS } from '../../../engine/orchestration/constants'
import { retirePool } from '../../../engine/orchestration/repair'
import { ensurePool } from '../../../engine/orchestration/scale-out'
import type { OrchestratorState } from '../../../engine/orchestration/types'
import { ErrorCodes } from '../../../errors'
import { createWorkerPool } from '../../../workers/pool'
import { emptyOrchestratorState, settle } from './fixtures'

function retireAPoolWhoseThreadStaysAlive(state: OrchestratorState): { exit: () => void } {
  let exit: () => void = () => undefined
  const pool = createWorkerPool({
    count: 2,
    workerFactory: (_workerId, _onDeath, onGone) => {
      exit = () => onGone?.()
      return {
        execute: <T>(): Promise<T> => Promise.resolve(undefined as T),
        shutdown: () => new Promise<void>(() => undefined),
      }
    },
  })
  pool.addIndex('prose')
  state.workerPool = pool
  retirePool(state, pool)
  return { exit: () => exit() }
}

describe('a pool that starts after another was retired', () => {
  beforeEach(() => {
    started.threads = 0
  })

  it('starts no thread until every thread of the retired pool has exited', async () => {
    const state = emptyOrchestratorState({ workersEnabled: true, keywordWorkerCount: 2 })
    const { exit } = retireAPoolWhoseThreadStaysAlive(state)

    const starting = ensurePool(state)
    await settle()
    expect(started.threads).toBe(0)

    exit()
    const pool = await starting

    expect(started.threads).toBe(2)
    expect(state.workerPool).toBe(pool)
    await pool.shutdown()
  })

  it('gives the start up while a retired thread outlives the exit wait, so that no write waits on it for good', async () => {
    vi.useFakeTimers()
    try {
      const state = emptyOrchestratorState({ workersEnabled: true, keywordWorkerCount: 2 })
      retireAPoolWhoseThreadStaysAlive(state)

      const starting = ensurePool(state)
      const outcome = expect(starting).rejects.toMatchObject({ code: ErrorCodes.WORKER_TIMEOUT })
      await vi.advanceTimersByTimeAsync(RETIRED_THREADS_EXIT_WAIT_MS)

      await outcome
      expect(started.threads).toBe(0)
      expect(state.workerPool).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the start up once the engine shuts down', async () => {
    let announceShutdown: () => void = () => undefined
    const shutdownStarted = new Promise<void>(resolve => {
      announceShutdown = resolve
    })
    const state = emptyOrchestratorState({ workersEnabled: true, shutdownStarted })
    retireAPoolWhoseThreadStaysAlive(state)

    const starting = ensurePool(state)
    state.shuttingDown = true
    announceShutdown()

    await expect(starting).rejects.toMatchObject({ code: ErrorCodes.WORKER_CRASHED })
    expect(started.threads).toBe(0)
  })
})
