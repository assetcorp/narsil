import type { TurnScheduler } from './turn-scheduler'

export {
  backgroundTurnIsSpent,
  holdWrites,
  holdWritesAndBackgroundWork,
  turnsAreBudgeted,
  yieldBackgroundTurn,
} from './turn-budget.react-native'

export function adoptBackgroundScheduler(_scheduler: TurnScheduler): void {}
