import { describe, expect, it } from 'vitest'
import { mergeDistributedGroups } from '../../../distribution/query/group-merge'
import type { WireGroupEntry } from '../../../distribution/transport/types'

function group(values: Record<string, unknown>, scored: Array<[string, number | null]>): WireGroupEntry {
  return { values, scored: scored.map(([docId, score]) => ({ docId, score, sortValues: null })) }
}

describe('mergeDistributedGroups', () => {
  it('merges groups sharing values and keeps the global best entries per group', () => {
    const nodeA = [
      group({ category: 'tools' }, [
        ['a1', 9],
        ['a2', 4],
      ]),
      group({ category: 'kitchen' }, [['k1', 6]]),
    ]
    const nodeB = [
      group({ category: 'tools' }, [
        ['b1', 7],
        ['b2', 5],
      ]),
    ]

    const merged = mergeDistributedGroups([nodeA, nodeB], ['category'], 2, null, null)

    expect(merged).toHaveLength(2)
    expect(merged[0].values).toEqual({ category: 'tools' })
    expect(merged[0].scored.map(entry => entry.docId)).toEqual(['a1', 'b1'])
    expect(merged[1].values).toEqual({ category: 'kitchen' })
  })

  it('orders merged groups by their first entry and truncates to the limit', () => {
    const nodeA = [group({ category: 'tools' }, [['a1', 3]]), group({ category: 'kitchen' }, [['k1', 6]])]
    const nodeB = [group({ category: 'garden' }, [['g1', 5]])]

    const merged = mergeDistributedGroups([nodeA, nodeB], ['category'], 1, 2, null)

    expect(merged.map(entry => entry.values.category)).toEqual(['kitchen', 'garden'])
  })

  it('distinguishes groups by field order, never by value collision', () => {
    const nodeA = [group({ a: 'x', b: 'y' }, [['d1', 2]])]
    const nodeB = [group({ a: 'y', b: 'x' }, [['d2', 1]])]

    const merged = mergeDistributedGroups([nodeA, nodeB], ['a', 'b'], 1, null, null)
    expect(merged).toHaveLength(2)
  })
})
