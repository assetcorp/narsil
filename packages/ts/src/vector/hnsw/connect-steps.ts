import { CONNECT_STEPS_BETWEEN_CLOCK_CHECKS } from '#platform/vector-core-host'

export type Steps<T = void> = Generator<void, T, undefined>

export interface Pace {
  steps: number
}

export function newPace(): Pace {
  return { steps: 0 }
}

export function stepTaken(pace: Pace): boolean {
  pace.steps += 1
  if (pace.steps < CONNECT_STEPS_BETWEEN_CLOCK_CHECKS) return false
  pace.steps = 0
  return true
}

export function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
  }
}
