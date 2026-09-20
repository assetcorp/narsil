export class GrowableUint32 {
  values: Uint32Array
  length = 0

  constructor(capacity: number) {
    this.values = new Uint32Array(capacity)
  }

  private growTo(needed: number, kept: number): void {
    let capacity = this.values.length * 2
    while (capacity < needed) capacity *= 2
    const next = new Uint32Array(capacity)
    next.set(this.values.subarray(0, kept))
    this.values = next
  }

  reserve(extra: number): void {
    const needed = this.length + extra
    if (needed > this.values.length) this.growTo(needed, this.length)
  }

  push(value: number): void {
    if (this.length === this.values.length) this.growTo(this.length + 1, this.length)
    this.values[this.length++] = value
  }

  ensureIndex(index: number): void {
    if (index >= this.values.length) this.growTo(index + 1, this.values.length)
  }

  clear(): void {
    this.length = 0
  }
}
