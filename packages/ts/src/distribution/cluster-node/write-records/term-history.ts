import type { TermStart } from '../../../persistence/durability/types'

export interface TermHistory {
  readonly highestSeqNo: number
  noteEntry(seqNo: number, primaryTerm: number): void
  termOf(seqNo: number): number | null
  starts(upToSeqNo: number): TermStart[]
  replace(starts: readonly TermStart[], highestSeqNo: number): void
  prune(floorSeqNo: number): void
  clear(): void
}

export function createTermHistory(): TermHistory {
  let starts: TermStart[] = []
  let highestSeqNo = 0

  return {
    get highestSeqNo() {
      return highestSeqNo
    },

    noteEntry(seqNo, primaryTerm) {
      const last = starts.at(-1)
      if (last === undefined || primaryTerm > last.primaryTerm) starts.push({ primaryTerm, firstSeqNo: seqNo })
      if (seqNo > highestSeqNo) highestSeqNo = seqNo
    },

    termOf(seqNo) {
      if (seqNo > highestSeqNo) return null
      let term: number | null = null
      for (const start of starts) {
        if (start.firstSeqNo > seqNo) break
        term = start.primaryTerm
      }
      return term
    },

    starts(upToSeqNo) {
      return starts.filter(start => start.firstSeqNo <= upToSeqNo).map(start => ({ ...start }))
    },

    replace(next, nextHighest) {
      starts = next.map(start => ({ ...start }))
      highestSeqNo = nextHighest
    },

    prune(floorSeqNo) {
      while (starts.length > 1 && starts[1].firstSeqNo <= floorSeqNo) starts.shift()
    },

    clear() {
      starts = []
      highestSeqNo = 0
    },
  }
}
