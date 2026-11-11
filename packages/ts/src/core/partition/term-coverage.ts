import type { TermMatchPolicy } from '../../types/search'
import type { ScoreBuffer } from './score-buffer'

export class TermCoverage {
  private readonly counts: Uint32Array
  private readonly lastTerm: Uint32Array
  private term = 0

  constructor(
    capacity: number,
    private readonly required: number,
  ) {
    this.counts = new Uint32Array(capacity)
    this.lastTerm = new Uint32Array(capacity)
  }

  nextTerm(): void {
    this.term++
  }

  mark(ordinal: number): void {
    if (this.lastTerm[ordinal] === this.term) return
    this.lastTerm[ordinal] = this.term
    this.counts[ordinal]++
  }

  retainCovered(buffer: ScoreBuffer): void {
    let count = 0
    for (let at = 0; at < buffer.touchedCount; at++) {
      const ordinal = buffer.touched[at]
      if (this.counts[ordinal] >= this.required) buffer.touched[count++] = ordinal
    }
    buffer.touchedCount = count
  }
}

export function termCoverage(
  capacity: number,
  terms: number,
  policy: TermMatchPolicy | undefined,
): TermCoverage | null {
  const required = policy === 'all' ? terms : typeof policy === 'number' ? policy : 0
  return terms > 0 && required > 0 ? new TermCoverage(capacity, required) : null
}
