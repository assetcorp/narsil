export const SINGLE_NODE_PRIMARY_TERM = 1

export interface SeqOwner {
  next(): number
  readonly current: number
  readonly primaryTerm: number
}

export function createSeqOwner(startSeqNo: number, primaryTerm: number = SINGLE_NODE_PRIMARY_TERM): SeqOwner {
  let current = startSeqNo

  return {
    next(): number {
      current += 1
      return current
    },
    get current(): number {
      return current
    },
    get primaryTerm(): number {
      return primaryTerm
    },
  }
}
