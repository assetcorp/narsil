export interface SearchClock {
  tick(units: number): void
  check(): void
}

export const STEADY_CLOCK: SearchClock = {
  tick: () => undefined,
  check: () => undefined,
}
