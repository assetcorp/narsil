import type { PatternWorkMeter } from '../core/pattern-index/types'
import { PATTERN_WORK_FLUSH_UNITS } from './constants'

export class WorkTally {
  private pending = 0
  private headroom: number

  constructor(private readonly meter: PatternWorkMeter) {
    this.headroom = meter.remaining()
  }

  add(units: number): void {
    this.pending += units
    if (this.pending >= PATTERN_WORK_FLUSH_UNITS || this.pending > this.headroom) this.flush()
  }

  flush(): void {
    if (this.pending === 0) return
    const units = this.pending
    this.pending = 0
    this.meter.add(units)
    this.headroom = this.meter.remaining()
  }
}
