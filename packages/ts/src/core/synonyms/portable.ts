import type { NativeSynonymCore, NativeSynonymTable } from '../../vector/native/types/synonyms'
import { encodeLookupKey } from '../partition/frozen/string-blob'
import { regionsOverlap } from '../regions'
import { typedRegion } from '../stored-values/regions'
import { storedText } from '../stored-values/text'
import { SYNONYMS_ADDED_PER_QUERY } from './constants'
import { readSynonymTable, validQueryStarts } from './regions'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function rankOf(table: NativeSynonymTable, text: string): number {
  const key = encodeLookupKey(text)
  let low = 0
  let high = table.offsets.length - 1
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const start = table.offsets[middle]
    const end = table.offsets[middle + 1]
    try {
      decoder.decode(table.tokens.subarray(start, end))
    } catch {
      return -2
    }
    let order = 0
    for (let at = 0; at < Math.min(end - start, key.length) && order === 0; at++) {
      order = table.tokens[start + at] - key[at]
    }
    if (order === 0) order = end - start - key.length
    if (order === 0) return middle
    if (order < 0) low = middle + 1
    else high = middle
  }
  return -1
}

function collect(table: NativeSynonymTable, token: number): number[] | null {
  const found: number[] = []
  for (let at = table.tokenStart[token]; at < table.tokenStart[token + 1]; at++) {
    const rule = table.tokenRules[at]
    const source = table.ruleSource[rule]
    if (source >= 0 && source !== token) return null
    let holdsToken = source >= 0
    for (let entry = table.ruleStart[rule]; entry < table.ruleStart[rule + 1]; entry++) {
      const added = table.ruleTokens[entry]
      if (added === token) {
        holdsToken = true
        continue
      }
      let position = 0
      while (position < found.length && found[position] < added) position++
      if (position === SYNONYMS_ADDED_PER_QUERY || found[position] === added) continue
      found.splice(position, 0, added)
      if (found.length > SYNONYMS_ADDED_PER_QUERY) found.pop()
    }
    if (!holdsToken) return null
  }
  return found
}

export const expandSynonyms: NativeSynonymCore['expandSynonyms'] = (
  input,
  queryUnits,
  queryStarts,
  queries,
  offsets,
  tokens,
) => {
  const table = readSynonymTable(input)
  const units = typedRegion(queryUnits, 'Uint16Array')
  const starts = typedRegion(queryStarts, 'Uint32Array')
  const outQueries = typedRegion(queries, 'Uint32Array')
  const outOffsets = typedRegion(offsets, 'Uint32Array')
  const outTokens = typedRegion(tokens, 'Uint32Array')
  if (
    table === null ||
    units === null ||
    starts === null ||
    outQueries === null ||
    outOffsets === null ||
    outTokens === null ||
    !validQueryStarts(starts, units)
  )
    return -1
  const reads = [...Object.values(table), units, starts]
  const writes = [outQueries, outOffsets, outTokens]
  for (let at = 0; at < writes.length; at++) {
    if (reads.some(read => regionsOverlap(read, writes[at]))) return -1
    for (let previous = 0; previous < at; previous++) if (regionsOverlap(writes[at], writes[previous])) return -1
  }
  const groups: Array<{ query: number; tokens: number[] }> = []
  const seen = new Set<string>()
  for (let query = 0; query + 1 < starts.length && groups.length < SYNONYMS_ADDED_PER_QUERY; query++) {
    const text = storedText(units, starts[query], starts[query + 1] - starts[query])
    if (seen.has(text)) continue
    seen.add(text)
    const rank = rankOf(table, text)
    if (rank === -2) return -1
    if (rank < 0) continue
    const found = collect(table, rank)
    if (found === null) return -1
    if (found.length > 0) groups.push({ query, tokens: found })
  }
  let needed = 0
  for (let at = 0; at < groups.length; at++) {
    const quota =
      Math.floor(SYNONYMS_ADDED_PER_QUERY / groups.length) + Number(at < SYNONYMS_ADDED_PER_QUERY % groups.length)
    groups[at].tokens.length = Math.min(groups[at].tokens.length, quota)
    needed += groups[at].tokens.length
  }
  if (outQueries.length < groups.length || outOffsets.length < groups.length + 1 || outTokens.length < needed) return -3
  let cursor = 0
  for (let at = 0; at < groups.length; at++) {
    outQueries[at] = groups[at].query
    outOffsets[at] = cursor
    outTokens.set(groups[at].tokens, cursor)
    cursor += groups[at].tokens.length
  }
  outOffsets[groups.length] = cursor
  return groups.length
}
