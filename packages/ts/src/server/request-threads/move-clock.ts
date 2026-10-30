import type { SearchClock } from '../../core/search-clock'
import { SEARCH_CLOCK_SAMPLE_UNITS } from '../constants'

export class SearchMoved extends Error {
  constructor() {
    super('This search ran past the point where its thread hands it on')
    this.name = 'SearchMoved'
  }
}

export function moveClock(moveAfterMs: number): SearchClock {
  const moveAt = performance.now() + moveAfterMs
  let pending = 0
  const clock: SearchClock = {
    tick(units: number): void {
      pending += units
      if (pending >= SEARCH_CLOCK_SAMPLE_UNITS) clock.check()
    },
    check(): void {
      pending = 0
      if (performance.now() > moveAt) throw new SearchMoved()
    },
  }
  return clock
}
