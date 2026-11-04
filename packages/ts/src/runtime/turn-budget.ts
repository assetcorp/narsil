export const turnsAreBudgeted = false

export function turnIsSpent(): boolean {
  return false
}

export function yieldTurn(): Promise<void> {
  return Promise.resolve()
}

export function backgroundTurnIsSpent(): boolean {
  return false
}

export function yieldBackgroundTurn(): Promise<void> {
  return Promise.resolve()
}

export function countWrite<T>(write: () => Promise<T>): Promise<T> {
  return write()
}

export function waitOutsideCountedWrite<T>(wait: () => Promise<T>): Promise<T> {
  return wait()
}

export function changeIndexOutsideExternalWaits<T>(change: () => Promise<T>): Promise<T> {
  return change()
}

export function indexChangeOutsideExternalWaits<T>(change: () => Promise<T>): () => Promise<T> {
  return change
}

export function holdWrites<T>(read: () => Promise<T>): Promise<T> {
  return read()
}

export function holdWritesAndBackgroundWork<T>(read: () => Promise<T>): Promise<T> {
  return read()
}
