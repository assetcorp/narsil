import type { TurnScheduler } from './turn-scheduler'

export {
  backgroundTurnIsSpent,
  holdWrites,
  holdWritesAndBackgroundWork,
  turnsAreBudgeted,
  yieldBackgroundTurn,
} from './turn-budget'

export function adoptBackgroundScheduler(_scheduler: TurnScheduler): void {}
