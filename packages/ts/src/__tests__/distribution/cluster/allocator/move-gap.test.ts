import { describe, expect, it } from 'vitest'
import { moveNarrowsGap } from '../../../../distribution/cluster/allocator/rebalance'
import type { NodeWeight } from '../../../../distribution/cluster/allocator/types'

function weight(nodeId: string, partitionCount: number, share = 1): NodeWeight {
  return {
    nodeId,
    weight: partitionCount / share,
    partitionCount,
    primaryWeight: 0,
    primaryCount: 0,
    capacity: 4_000_000_000 * share,
  }
}

const evenShares = new Map([
  ['node-a', 1],
  ['node-b', 1],
])

describe('moveNarrowsGap', () => {
  it('refuses a move that only turns the same gap around', () => {
    expect(moveNarrowsGap(weight('node-a', 3), weight('node-b', 2), evenShares)).toBe(false)
  })

  it('accepts a move that closes the gap outright', () => {
    expect(moveNarrowsGap(weight('node-a', 3), weight('node-b', 1), evenShares)).toBe(true)
  })

  it('accepts a move that leaves a smaller gap behind', () => {
    expect(moveNarrowsGap(weight('node-a', 5), weight('node-b', 0), evenShares)).toBe(true)
  })

  it('weighs a copy on a large node as less load than one on a small node', () => {
    const shares = new Map([
      ['node-big', 2],
      ['node-small', 0.5],
    ])
    expect(moveNarrowsGap(weight('node-big', 4, 2), weight('node-small', 1, 0.5), shares)).toBe(false)
    expect(moveNarrowsGap(weight('node-big', 8, 2), weight('node-small', 0, 0.5), shares)).toBe(true)
  })
})
