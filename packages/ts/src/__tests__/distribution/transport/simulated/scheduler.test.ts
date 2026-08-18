import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeterministicScheduler } from '../../../../distribution/transport/simulated/scheduler'
import { createDeterministicScheduler } from '../../../../distribution/transport/simulated/scheduler'

const START_TIME = 1_000_000_000

describe('deterministic scheduler', () => {
  let scheduler: DeterministicScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START_TIME)
    scheduler = createDeterministicScheduler({
      startTime: START_TIME,
      advanceTimers: ms => vi.advanceTimersByTimeAsync(ms),
    })
  })

  afterEach(() => {
    scheduler.dispose()
    vi.useRealTimers()
  })

  it('delivers events in time order regardless of enqueue order', async () => {
    const delivered: string[] = []
    scheduler.enqueue({ deliverAt: START_TIME + 30, run: () => void delivered.push('late') })
    scheduler.enqueue({ deliverAt: START_TIME + 10, run: () => void delivered.push('early') })
    scheduler.enqueue({ deliverAt: START_TIME + 20, run: () => void delivered.push('middle') })

    await scheduler.runUntilQuiet({ quietMs: 50, tickMs: 10 })

    expect(delivered).toEqual(['early', 'middle', 'late'])
  })

  it('breaks ties at one delivery time by enqueue order', async () => {
    const delivered: number[] = []
    for (let i = 0; i < 5; i++) {
      scheduler.enqueue({ deliverAt: START_TIME + 10, run: () => void delivered.push(i) })
    }

    await scheduler.runUntilQuiet({ quietMs: 50, tickMs: 10 })

    expect(delivered).toEqual([0, 1, 2, 3, 4])
  })

  it('advances the fake clock to each event, firing timers due on the way', async () => {
    const order: string[] = []
    setTimeout(() => void order.push('timer'), 50)
    scheduler.enqueue({ deliverAt: START_TIME + 100, run: () => void order.push('event') })

    const stepped = await scheduler.step()

    expect(stepped).toBe(true)
    expect(order).toEqual(['timer', 'event'])
    expect(scheduler.now).toBe(START_TIME + 100)
    expect(Date.now()).toBe(START_TIME + 100)
  })

  it('drains chains where one delivery enqueues the next', async () => {
    const delivered: string[] = []
    scheduler.enqueue({
      deliverAt: START_TIME + 5,
      run: () => {
        delivered.push('first')
        scheduler.enqueue({ deliverAt: scheduler.now + 5, run: () => void delivered.push('second') })
      },
    })

    await scheduler.runUntilQuiet({ quietMs: 50, tickMs: 10 })

    expect(delivered).toEqual(['first', 'second'])
  })

  it('lets a pending fake timer enqueue an event during the quiet window', async () => {
    const delivered: string[] = []
    setTimeout(() => {
      scheduler.enqueue({ deliverAt: scheduler.now + 1, run: () => void delivered.push('from-timer') })
    }, 300)

    await scheduler.runUntilQuiet({ quietMs: 500, tickMs: 50 })

    expect(delivered).toEqual(['from-timer'])
  })

  it('stops after the event budget is spent', async () => {
    let delivered = 0
    const reschedule = () => {
      delivered++
      scheduler.enqueue({ deliverAt: scheduler.now + 1, run: reschedule })
    }
    scheduler.enqueue({ deliverAt: START_TIME + 1, run: reschedule })

    await scheduler.runUntilQuiet({ maxEvents: 20, quietMs: 50, tickMs: 10 })

    expect(delivered).toBe(20)
  })

  it('returns the wrapped function value from runWithDrain', async () => {
    const result = await scheduler.runWithDrain(async () => {
      const value = await new Promise<string>(resolve => {
        scheduler.enqueue({ deliverAt: scheduler.now + 25, run: () => resolve('delivered') })
      })
      return `${value}-and-returned`
    })

    expect(result).toBe('delivered-and-returned')
  })

  it('keeps ticking past the quiet window until the wrapped function settles', async () => {
    const result = await scheduler.runWithDrain(
      () =>
        new Promise<string>(resolve => {
          setTimeout(() => resolve('late-timer'), 2_000)
        }),
      { quietMs: 100, tickMs: 50 },
    )

    expect(result).toBe('late-timer')
  })

  it('propagates a rejection from the wrapped function', async () => {
    await expect(
      scheduler.runWithDrain(async () => {
        throw new Error('wrapped failure')
      }),
    ).rejects.toThrow('wrapped failure')
  })

  it('advances both clocks together with advanceBy', async () => {
    await scheduler.advanceBy(250)
    expect(scheduler.now).toBe(START_TIME + 250)
    expect(Date.now()).toBe(START_TIME + 250)
  })

  it('delivers nothing after dispose and ignores later enqueues', async () => {
    const delivered: string[] = []
    scheduler.enqueue({ deliverAt: START_TIME + 5, run: () => void delivered.push('before') })
    scheduler.dispose()
    scheduler.enqueue({ deliverAt: START_TIME + 5, run: () => void delivered.push('after') })

    const stepped = await scheduler.step()

    expect(stepped).toBe(false)
    expect(scheduler.pendingCount).toBe(0)
    expect(delivered).toEqual([])
  })
})
