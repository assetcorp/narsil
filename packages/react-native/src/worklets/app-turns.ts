import { APP_TIMER_WAIT_BEFORE_RUN_LOOP_HOP_MS } from '../constants'

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
    } else if (now - appTimerArmedAt >= APP_TIMER_WAIT_BEFORE_RUN_LOOP_HOP_MS) {
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

export function afterAppTurn(run: () => void): void {
  hop ??= hopThroughRuntimeScheduler() ?? hopThroughTimer
  hop(run)
}
