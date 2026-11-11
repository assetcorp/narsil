import { expandSynonyms } from '#platform/synonym-expansion'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeSynonymTable } from '../../vector/native/types/synonyms'
import { SYNONYM_EXPANSION_CACHE_ENTRIES, SYNONYMS_ADDED_PER_QUERY } from './constants'

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

export function synonymSelection(
  table: NativeSynonymTable,
): (tokens: Iterable<string>) => ReadonlyMap<string, readonly string[]> {
  const cache = new Map<string, ReadonlyMap<string, readonly string[]>>()
  const queries = new Uint32Array(SYNONYMS_ADDED_PER_QUERY)
  const offsets = new Uint32Array(SYNONYMS_ADDED_PER_QUERY + 1)
  const selected = new Uint32Array(SYNONYMS_ADDED_PER_QUERY)
  return input => {
    const tokens = [...new Set(input)]
    const key = JSON.stringify(tokens)
    const cached = cache.get(key)
    if (cached !== undefined) {
      cache.delete(key)
      cache.set(key, cached)
      return cached
    }
    let total = 0
    for (const token of tokens) total += token.length
    if (total > 0xffffffff || tokens.length > 0xffffffff) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The synonym query exceeds the text layout')
    }
    const units = new Uint16Array(total)
    const starts = new Uint32Array(tokens.length + 1)
    let cursor = 0
    for (let at = 0; at < tokens.length; at++) {
      starts[at] = cursor
      for (let unit = 0; unit < tokens[at].length; unit++) units[cursor++] = tokens[at].charCodeAt(unit)
    }
    starts[tokens.length] = cursor
    const count = expandSynonyms(table, units, starts, queries, offsets, selected)
    if (count < 0)
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The synonym query could not be expanded', { status: -count })
    const groups = new Map<string, readonly string[]>()
    for (let group = 0; group < count; group++) {
      const synonyms: string[] = []
      for (let at = offsets[group]; at < offsets[group + 1]; at++) {
        const rank = selected[at]
        synonyms.push(decoder.decode(table.tokens.subarray(table.offsets[rank], table.offsets[rank + 1])))
      }
      groups.set(tokens[queries[group]], Object.freeze(synonyms))
    }
    if (cache.size >= SYNONYM_EXPANSION_CACHE_ENTRIES) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, groups)
    return groups
  }
}
