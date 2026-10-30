export interface SearchClock {
  tick(units: number): void
  check(): void
}
