export const SINGLE_NODE_PRIMARY_TERM = 1

export interface SeqOwner {
  next(): number
  advanceTo(seqNo: number, primaryTerm: number): void
  readonly current: number
  readonly primaryTerm: number
}

export function createSeqOwner(startSeqNo: number, primaryTerm: number = SINGLE_NODE_PRIMARY_TERM): SeqOwner {
  let current = startSeqNo
  let term = primaryTerm

  return {
    next(): number {
      current += 1
      return current
    },
    advanceTo(seqNo: number, nextPrimaryTerm: number): void {
      current = seqNo
      term = nextPrimaryTerm
    },
    get current(): number {
      return current
    },
    get primaryTerm(): number {
      return term
    },
  }
}
