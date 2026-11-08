import { bitsetClear, bitsetSet, createBitSet } from '../bitset'

export class LiveOrdinals {
  private held: Uint32Array | null = null

  reserve(ordinal: number): void {
    if (this.held === null || ordinal >>> 5 < this.held.length) return
    const next = new Uint32Array(Math.max((ordinal >>> 5) + 1, this.held.length * 2))
    next.set(this.held)
    this.held = next
  }

  add(ordinal: number): void {
    if (this.held !== null) bitsetSet(this.held, ordinal)
  }

  remove(ordinal: number): void {
    if (this.held !== null) bitsetClear(this.held, ordinal)
  }

  clear(): void {
    this.held = null
  }

  regions(capacity: number, ordinals: () => Iterable<number>): Uint32Array {
    if (this.held === null) {
      const bits = createBitSet(capacity)
      for (const ordinal of ordinals()) bitsetSet(bits, ordinal)
      this.held = bits
    }
    return this.held.subarray(0, Math.max(1, Math.ceil(capacity / 32)))
  }

  bytes(): number {
    return this.held?.byteLength ?? 0
  }
}
