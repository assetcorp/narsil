import type { DocIdMap } from './types'

export function createDocIdMap<V>(): DocIdMap<V> {
  return new Map<string, V>()
}
