import { bitsetSet, createBitSet } from '../bitset'

export class FieldPresence {
  private held: Uint32Array | null = null

  constructor(private readonly ordinals: () => Iterable<number>) {}

  invalidate(): void {
    this.held = null
  }

  regions(capacity: number): Uint32Array {
    const words = Math.max(1, Math.ceil(capacity / 32))
    if (this.held === null || this.held.length < words) {
      const bits = createBitSet(capacity)
      for (const ordinal of this.ordinals()) bitsetSet(bits, ordinal)
      this.held = bits
    }
    return this.held.subarray(0, words)
  }

  bytes(): number {
    return this.held?.byteLength ?? 0
  }
}
