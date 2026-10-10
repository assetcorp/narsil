import type { NarsilClient } from '../client'
import type { Narsil } from '../types/engine'
import type { AnyDocument } from '../types/schema'
import type { ListParams, QueryParams } from '../types/search'

export type NarsilReader = Pick<
  NarsilClient,
  'query' | 'preflight' | 'suggest' | 'get' | 'listDocuments' | 'listIndexes' | 'getStats'
>

function plainNumbersIn(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) {
    return value instanceof DataView ? value : Array.from(value as unknown as ArrayLike<number>)
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null
    for (let at = 0; at < value.length; at++) {
      const converted = plainNumbersIn(value[at])
      if (converted === value[at]) continue
      copy ??= value.slice()
      copy[at] = converted
    }
    return copy ?? value
  }
  let copy: Record<string, unknown> | null = null
  for (const [key, held] of Object.entries(value)) {
    const converted = plainNumbersIn(held)
    if (converted === held) continue
    copy ??= { ...value }
    copy[key] = converted
  }
  return copy ?? value
}

function withPlainNumbers<T>(answer: Promise<T>): Promise<T> {
  return answer.then(value => plainNumbersIn(value) as T)
}

export function engineReader(engine: Narsil): NarsilReader {
  return {
    query<T = AnyDocument>(indexName: string, params: QueryParams) {
      return withPlainNumbers(engine.query<T>(indexName, params))
    },
    preflight: (indexName, params) => engine.preflight(indexName, params),
    suggest: (indexName, params) => engine.suggest(indexName, params),
    get: (indexName, docId) => withPlainNumbers(engine.get(indexName, docId)),
    listDocuments<T = AnyDocument>(indexName: string, params?: ListParams) {
      return withPlainNumbers(engine.listDocuments<T>(indexName, params))
    },
    listIndexes: async () => engine.listIndexes(),
    getStats: async indexName => engine.getStats(indexName),
  }
}
