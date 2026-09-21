import { describe, expect, it } from 'vitest'
import type { Executor } from '../../workers/executor'
import { createWorkerPool } from '../../workers/pool'

interface StartedThread {
  die(error: Error): void
  exit(): void
  finishShutdown(): void
}

function poolOfThreads(count: number) {
  const threads: StartedThread[] = []
  const pool = createWorkerPool({
    count,
    workerFactory: (_workerId, onDeath, onGone) => {
      let finishShutdown: () => void = () => undefined
      const stopped = new Promise<void>(resolve => {
        finishShutdown = resolve
      })
      const executor: Executor = {
        execute: <T>(): Promise<T> => Promise.resolve(undefined as T),
        shutdown: () => stopped,
      }
      threads.push({
        die: error => onDeath?.(error),
        exit: () => onGone?.(),
        finishShutdown,
      })
      return executor
    },
  })
  pool.spawnAll()
  return { pool, threads }
}

async function settledWithin(promise: Promise<void>, turns: number): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
  return settled
}

describe('the threads a worker pool started', () => {
  it('counts as gone at once for a pool that started none', async () => {
    const pool = createWorkerPool({
      count: 2,
      workerFactory: () => {
        throw new Error('this pool starts no thread')
      },
    })

    expect(await settledWithin(pool.whenEveryThreadIsGone(), 3)).toBe(true)
  })

  it('count as gone once each has finished its shutdown', async () => {
    const { pool, threads } = poolOfThreads(2)
    const gone = pool.whenEveryThreadIsGone()
    const stopping = pool.shutdown()

    threads[0].finishShutdown()
    expect(await settledWithin(gone, 5)).toBe(false)
    threads[1].finishShutdown()

    await stopping
    expect(await settledWithin(gone, 5)).toBe(true)
  })

  it('keep a crashed thread as running until it exits', async () => {
    const { pool, threads } = poolOfThreads(2)
    threads[0].die(new Error('no answer to 3 consecutive requests'))
    threads[1].finishShutdown()
    const gone = pool.whenEveryThreadIsGone()
    void pool.shutdown()

    expect(await settledWithin(gone, 5)).toBe(false)
    threads[0].exit()

    expect(await settledWithin(gone, 5)).toBe(true)
  })
})
