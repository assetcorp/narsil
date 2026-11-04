const RECORDED_BUSY_STRETCH_MS = 10
const APP_TIMER_WAIT_BEFORE_RUN_LOOP_HOP_MS = 100

export interface BusyStretch {
  startMs: number
  ms: number
}

export interface BusyProbe {
  stop(): void
  longestBusyMs(): number
  longestBusyWithin(startMs: number, endMs: number): number
}

interface RuntimeScheduler {
  schedule(callback: () => void): void
}

function appRuntimeScheduler(): RuntimeScheduler | null {
  const scheduler: unknown = Reflect.get(globalThis, 'nativeRuntimeScheduler')
  if (typeof scheduler !== 'object' || scheduler === null) return null
  const scheduleCallback: unknown = Reflect.get(scheduler, 'unstable_scheduleCallback')
  const normalPriority: unknown = Reflect.get(scheduler, 'unstable_NormalPriority')
  if (typeof scheduleCallback !== 'function' || typeof normalPriority !== 'number') return null
  let appTimerArmedAt: number | null = null
  let callbackAfterAppTimer: (() => void) | null = null

  function appTimerFired(): void {
    appTimerArmedAt = null
    const callback = callbackAfterAppTimer
    callbackAfterAppTimer = null
    callback?.()
  }

  return {
    schedule(callback) {
      const now = performance.now()
      if (appTimerArmedAt === null) {
        appTimerArmedAt = now
        setTimeout(appTimerFired, 0)
      } else if (now - appTimerArmedAt >= APP_TIMER_WAIT_BEFORE_RUN_LOOP_HOP_MS) {
        callbackAfterAppTimer = callback
        return
      }
      Reflect.apply(scheduleCallback, scheduler, [normalPriority, callback])
    },
  }
}

export function startBusyProbe(origin: number): BusyProbe | null {
  const found = appRuntimeScheduler()
  if (found === null) return null
  const scheduler: RuntimeScheduler = found
  const stretches: BusyStretch[] = []
  let lastRunAt = performance.now()
  let longest = 0
  let running = true

  function record(now: number): void {
    const ms = now - lastRunAt
    if (ms > longest) longest = ms
    if (ms >= RECORDED_BUSY_STRETCH_MS) stretches.push({ startMs: lastRunAt - origin, ms })
    lastRunAt = now
  }

  function run(): void {
    if (!running) return
    record(performance.now())
    scheduler.schedule(run)
  }

  scheduler.schedule(run)
  return {
    stop(): void {
      if (!running) return
      running = false
      record(performance.now())
    },
    longestBusyMs: () => longest,
    longestBusyWithin(startMs: number, endMs: number): number {
      let within = 0
      for (const stretch of stretches) {
        if (stretch.startMs < endMs && stretch.startMs + stretch.ms > startMs) within = Math.max(within, stretch.ms)
      }
      return within
    },
  }
}
