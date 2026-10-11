import type { PatternWorkMeter } from '../core/pattern-index/types'

export class WorkTally {
  private pending = 0
  private headroom: number

  constructor(private readonly meter: PatternWorkMeter) {
    this.headroom = meter.remaining()
  }

  add(units: number): void {
    this.pending += units
    if (this.pending >= this.meter.flushUnits || this.pending > this.headroom) this.flush()
  }

  flush(): void {
    if (this.pending === 0) return
    const units = this.pending
    this.pending = 0
    this.meter.add(units)
    this.headroom = this.meter.remaining()
  }
}
