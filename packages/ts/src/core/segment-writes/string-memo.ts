const LAST_STAMP = 0xffffffff

export class StampedMemo {
  private stamps = new Uint32Array(0)
  private values = new Uint32Array(0)
  private stamp = 0
  owner: object | null = null

  claim(owner: object, size: number): void {
    if (size > this.stamps.length) {
      const capacity = Math.max(size, this.stamps.length * 2)
      this.stamps = new Uint32Array(capacity)
      this.values = new Uint32Array(capacity)
      this.stamp = 0
    }
    if (this.stamp === LAST_STAMP) {
      this.stamps.fill(0)
      this.stamp = 0
    }
    this.stamp++
    this.owner = owner
  }

  get(key: number): number {
    return key < this.stamps.length && this.stamps[key] === this.stamp ? this.values[key] : -1
  }

  set(key: number, value: number): void {
    if (key >= this.stamps.length) return
    this.stamps[key] = this.stamp
    this.values[key] = value
  }
}

const memoByTable = new WeakMap<object, StampedMemo>()

export function memoFor(table: object): StampedMemo {
  let memo = memoByTable.get(table)
  if (memo === undefined) {
    memo = new StampedMemo()
    memoByTable.set(table, memo)
  }
  return memo
}
