import { UI_THREAD_TURN_BUDGET_MS } from './constants'

let turnStartedAt = performance.now()

export function turnIsSpent(): boolean {
  return performance.now() - turnStartedAt >= UI_THREAD_TURN_BUDGET_MS
}

export function turnStarted(): void {
  turnStartedAt = performance.now()
}

export function yieldTurn(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => {
      turnStarted()
      resolve()
    }, 0)
  })
}
