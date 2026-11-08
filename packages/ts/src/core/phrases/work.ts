import { NANOSECONDS_PER_MILLISECOND, WORK_FLUSH_UNITS } from './constants'

const INT64_MAX = 0x7fffffffffffffffn

export class PhraseWork {
  private pending = 0
  private headroom: number
  status = 0

  constructor(
    private readonly meter: BigInt64Array,
    private readonly stop: Uint32Array,
    private readonly deadline: bigint,
  ) {
    const spent = Atomics.load(meter, 0)
    this.headroom = Number(meter[1] - spent)
    if (spent > meter[1]) this.status = -6
    else this.checkStop()
  }

  private checkStop(): void {
    if (
      Atomics.load(this.stop, 0) !== 0 ||
      (this.deadline !== 0n && BigInt(Math.floor(performance.now() * NANOSECONDS_PER_MILLISECOND)) > this.deadline)
    )
      this.status = -7
  }

  flush(): number {
    if (this.status !== 0) return this.status
    if (this.pending > 0) {
      let previous = Atomics.load(this.meter, 0)
      for (;;) {
        const next = previous + BigInt(this.pending)
        if (previous < 0n || next > INT64_MAX) {
          this.status = -6
          break
        }
        const found = Atomics.compareExchange(this.meter, 0, previous, next)
        if (found === previous) {
          this.headroom = Number(this.meter[1] - next)
          if (next > this.meter[1]) this.status = -6
          break
        }
        previous = found
      }
      this.pending = 0
    }
    if (this.status === 0) this.checkStop()
    return this.status
  }

  add(units: number): number {
    while (units > 0 && this.status === 0) {
      const kept = Math.min(units, WORK_FLUSH_UNITS - this.pending)
      this.pending += kept
      units -= kept
      if (this.pending === WORK_FLUSH_UNITS || this.pending > this.headroom) this.flush()
    }
    return this.status
  }
}
