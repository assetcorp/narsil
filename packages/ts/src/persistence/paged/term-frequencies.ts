import { mergeDocFrequencies } from '../../core/partition/composite/stats'
import type { PartitionReadState } from '../../core/partition/read-state'

export function termFrequenciesAcross(states: () => readonly PartitionReadState[]): Readonly<Record<string, number>> {
  function countOf(token: string | symbol): number {
    if (typeof token !== 'string') return 0
    let count = 0
    for (const state of states()) count += state.invertedIdx.documentFrequency(token)
    return count
  }

  return new Proxy<Record<string, number>>(Object.create(null), {
    get: (_target, token) => countOf(token) || undefined,
    has: (_target, token) => countOf(token) > 0,
    getOwnPropertyDescriptor(_target, token) {
      const value = countOf(token)
      return value > 0 ? { value, enumerable: true, configurable: true, writable: false } : undefined
    },
    ownKeys: () => Object.keys(mergeDocFrequencies(states())),
  })
}
