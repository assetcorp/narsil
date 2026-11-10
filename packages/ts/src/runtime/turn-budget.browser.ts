import type { TurnScheduler } from './turn-scheduler'

export const turnsAreBudgeted = true

export let turnIsSpent = (): boolean => false

export let yieldTurn = (): Promise<void> => Promise.resolve()

export let countWrite = <T>(write: () => Promise<T>): Promise<T> => write()

export let changeIndexOutsideExternalWaits = <T>(change: () => T | Promise<T>): T | Promise<T> => change()

export function indexChangeOutsideExternalWaits<T>(change: () => T | Promise<T>): () => T | Promise<T> {
  return () => changeIndexOutsideExternalWaits(change)
}

export let waitOutsideCountedWrite = <T>(wait: () => Promise<T>): Promise<T> => wait()

export function adoptSharedTurns(scheduler: TurnScheduler): void {
  turnIsSpent = scheduler.turnIsSpent
  yieldTurn = scheduler.yieldTurn
  countWrite = scheduler.countWrite
  changeIndexOutsideExternalWaits = scheduler.changeIndexOutsideExternalWaits
  waitOutsideCountedWrite = scheduler.waitOutsideCountedWrite
}
