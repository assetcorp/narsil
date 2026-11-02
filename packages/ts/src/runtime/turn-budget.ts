export function turnIsSpent(): boolean {
  return false
}

export function yieldTurn(): Promise<void> {
  return Promise.resolve()
}

export function turnStarted(): void {}
