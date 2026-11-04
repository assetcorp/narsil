import { UI_THREAD_APP_TIMER_WAIT_BEFORE_RUN_LOOP_HOP_MS } from './constants'
import { createTurnScheduler } from './turn-scheduler'

type Hop = (run: () => void) => void

function hopThroughRuntimeScheduler(): Hop | null {
  const runtimeScheduler: unknown = Reflect.get(globalThis, 'nativeRuntimeScheduler')
  if (typeof runtimeScheduler !== 'object' || runtimeScheduler === null) return null
  const schedule: unknown = Reflect.get(runtimeScheduler, 'unstable_scheduleCallback')
  const priority: unknown = Reflect.get(runtimeScheduler, 'unstable_NormalPriority')
  if (typeof schedule !== 'function' || typeof priority !== 'number') return null
  let appTimerArmedAt: number | null = null
  let runsAfterAppTimer: Array<() => void> = []

  function appTimerFired(): void {
    appTimerArmedAt = null
    const runs = runsAfterAppTimer
    runsAfterAppTimer = []
    for (const run of runs) run()
  }

  return run => {
    const now = performance.now()
    if (appTimerArmedAt === null) {
      appTimerArmedAt = now
      setTimeout(appTimerFired, 0)
    } else if (now - appTimerArmedAt >= UI_THREAD_APP_TIMER_WAIT_BEFORE_RUN_LOOP_HOP_MS) {
      runsAfterAppTimer.push(run)
      return
    }
    Reflect.apply(schedule, runtimeScheduler, [
      priority,
      () => {
        run()
      },
    ])
  }
}

function hopThroughTimer(run: () => void): void {
  setTimeout(run, 0)
}

let hop: Hop | null = null

const scheduler = createTurnScheduler(run => {
  hop ??= hopThroughRuntimeScheduler() ?? hopThroughTimer
  hop(run)
})

export const turnsAreBudgeted = true

export function turnIsSpent(): boolean {
  return scheduler.turnIsSpent()
}

export function yieldTurn(): Promise<void> {
  return scheduler.yieldTurn()
}

export function backgroundTurnIsSpent(): boolean {
  return scheduler.backgroundTurnIsSpent()
}

export function yieldBackgroundTurn(): Promise<void> {
  return scheduler.yieldBackgroundTurn()
}

export function countWrite<T>(write: () => Promise<T>): Promise<T> {
  return scheduler.countWrite(write)
}

export function waitOutsideCountedWrite<T>(wait: () => Promise<T>): Promise<T> {
  return scheduler.waitOutsideCountedWrite(wait)
}

export function changeIndexOutsideExternalWaits<T>(change: () => Promise<T>): Promise<T> {
  return scheduler.changeIndexOutsideExternalWaits(change)
}

export function indexChangeOutsideExternalWaits<T>(change: () => Promise<T>): () => Promise<T> {
  return () => scheduler.changeIndexOutsideExternalWaits(change)
}

export function holdWrites<T>(read: () => Promise<T>): Promise<T> {
  return scheduler.holdWrites(read)
}

export function holdWritesAndBackgroundWork<T>(read: () => Promise<T>): Promise<T> {
  return scheduler.holdWritesAndBackgroundWork(read)
}
