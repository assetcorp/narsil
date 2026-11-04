import { UI_THREAD_TURN_BUDGET_MS } from './constants'
import { adoptSharedTurns } from './turn-budget.browser'
import type { TurnScheduler } from './turn-scheduler'

let turnStartedAt = performance.now()

export const turnsAreBudgeted = true

export let backgroundTurnIsSpent = (): boolean => performance.now() - turnStartedAt >= UI_THREAD_TURN_BUDGET_MS

export let yieldBackgroundTurn = (): Promise<void> =>
  new Promise(resolve => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      turnStartedAt = performance.now()
      resolve()
    }
    port2.postMessage(null)
  })

export let holdWrites = <T>(read: () => Promise<T>): Promise<T> => read()

export let holdWritesAndBackgroundWork = <T>(read: () => Promise<T>): Promise<T> => read()

export function adoptBackgroundScheduler(scheduler: TurnScheduler): void {
  adoptSharedTurns(scheduler)
  backgroundTurnIsSpent = scheduler.backgroundTurnIsSpent
  yieldBackgroundTurn = scheduler.yieldBackgroundTurn
  holdWrites = scheduler.holdWrites
  holdWritesAndBackgroundWork = scheduler.holdWritesAndBackgroundWork
}
