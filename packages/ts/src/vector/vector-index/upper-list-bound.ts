import { ErrorCodes, NarsilError } from '../../errors'

const UPPER_LISTS_PER_NODE_FACTOR = 4
const UPPER_LISTS_ALLOWANCE = 64

export function requireBoundedUpperLists(
  levelsOfParts: ReadonlyArray<ArrayLike<number>>,
  m: number,
  what: string,
): void {
  let nodes = 0
  let upperLists = 0
  for (const levels of levelsOfParts) {
    for (let at = 0; at < levels.length; at++) {
      const level = levels[at]
      if (level === 0) continue
      nodes++
      upperLists += level - 1
    }
  }
  const spread = m - 1
  if (upperLists * spread <= UPPER_LISTS_PER_NODE_FACTOR * nodes + UPPER_LISTS_ALLOWANCE * spread) return
  const limit = Math.floor((UPPER_LISTS_PER_NODE_FACTOR * nodes) / spread) + UPPER_LISTS_ALLOWANCE
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    `${what} holds ${upperLists} upper-layer lists over ${nodes} nodes, while a graph of ${nodes} nodes at m ${m} holds at most ${limit}`,
    { upperLists, nodes, m, limit },
  )
}
