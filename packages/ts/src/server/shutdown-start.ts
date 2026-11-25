const shutdownStarts = new WeakMap<object, () => void>()

export function bindShutdownStart(owner: object, start: () => void): void {
  shutdownStarts.set(owner, start)
}

export function shutdownStartOf(owner: object): (() => void) | undefined {
  return shutdownStarts.get(owner)
}
