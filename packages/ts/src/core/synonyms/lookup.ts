import type { SynonymRule } from '../../types/synonyms'
import { compareCodePoints } from '../ordering'
import { encodeLookupKey, encodeStringBlob } from '../partition/frozen/string-blob'
import { tokenize } from '../tokenizer'
import { SYNONYM_EXPANSION_CACHE_ENTRIES, SYNONYMS_ADDED_PER_QUERY } from './constants'
import { expandQuerySynonyms } from './expand'
import type { RaiseSynonymProblem, SynonymAnalysis, SynonymLookup } from './types'

const NO_SOURCE = -1
const NO_SYNONYMS: readonly string[] = Object.freeze([])
const decoder = new TextDecoder()

interface Interned {
  ids: Map<string, number>
  tokens: string[]
}

function analyseWord(word: string, analysis: SynonymAnalysis, cache: Map<string, string | number>): string | number {
  const cached = cache.get(word)
  if (cached !== undefined) return cached
  const { tokens } = tokenize(word, analysis.language, {
    stem: true,
    removeStopWords: true,
    customTokenizer: analysis.customTokenizer,
    stopWordOverride: analysis.stopWords,
  })
  const result = tokens.length === 1 ? tokens[0].token : tokens.length
  cache.set(word, result)
  return result
}

function intern(interned: Interned, token: string): number {
  let id = interned.ids.get(token)
  if (id === undefined) {
    id = interned.tokens.length
    interned.tokens.push(token)
    interned.ids.set(token, id)
  }
  return id
}

function sourceWordOf(rule: SynonymRule): string | undefined {
  return 'word' in rule ? rule.word : undefined
}

function targetWordsOf(rule: SynonymRule): readonly string[] {
  return 'words' in rule ? rule.words : rule.synonyms
}

function packedLookup(
  tokens: readonly string[],
  ruleStart: Uint32Array,
  ruleTokenIds: readonly number[],
  ruleSource: Int32Array,
): SynonymLookup {
  const order = tokens.map((_, id) => id).sort((a, b) => compareCodePoints(tokens[a], tokens[b]))
  const rank = new Uint32Array(tokens.length)
  for (let position = 0; position < order.length; position++) rank[order[position]] = position
  const { blob, offsets } = encodeStringBlob(order.map(id => tokens[id]))
  const ruleTokens = Uint32Array.from(ruleTokenIds, id => rank[id])
  const sources = Int32Array.from(ruleSource, id => (id === NO_SOURCE ? NO_SOURCE : rank[id]))
  const ruleCount = sources.length

  const tokenRuleStart = new Uint32Array(tokens.length + 1)
  for (let rule = 0; rule < ruleCount; rule++) {
    if (sources[rule] !== NO_SOURCE) tokenRuleStart[sources[rule] + 1]++
    else for (let i = ruleStart[rule]; i < ruleStart[rule + 1]; i++) tokenRuleStart[ruleTokens[i] + 1]++
  }
  for (let token = 0; token < tokens.length; token++) tokenRuleStart[token + 1] += tokenRuleStart[token]
  const tokenRules = new Uint32Array(tokenRuleStart[tokens.length])
  const fill = tokenRuleStart.slice(0, tokens.length)
  for (let rule = 0; rule < ruleCount; rule++) {
    if (sources[rule] !== NO_SOURCE) tokenRules[fill[sources[rule]]++] = rule
    else for (let i = ruleStart[rule]; i < ruleStart[rule + 1]; i++) tokenRules[fill[ruleTokens[i]]++] = rule
  }

  const cache = new Map<string, readonly string[]>()
  const bytes =
    blob.byteLength +
    offsets.byteLength +
    ruleStart.byteLength +
    ruleTokens.byteLength +
    sources.byteLength +
    tokenRuleStart.byteLength +
    tokenRules.byteLength

  function rankOf(token: string): number {
    const key = encodeLookupKey(token)
    let low = 0
    let high = offsets.length - 2
    while (low <= high) {
      const middle = (low + high) >>> 1
      const start = offsets[middle]
      const end = offsets[middle + 1]
      let order = 0
      const shorter = Math.min(end - start, key.length)
      for (let i = 0; i < shorter && order === 0; i++) order = blob[start + i] - key[i]
      if (order === 0) order = end - start - key.length
      if (order === 0) return middle
      if (order < 0) low = middle + 1
      else high = middle - 1
    }
    return -1
  }

  function collect(token: number): readonly string[] {
    const found: number[] = []
    for (let i = tokenRuleStart[token]; i < tokenRuleStart[token + 1]; i++) {
      const rule = tokenRules[i]
      for (let j = ruleStart[rule]; j < ruleStart[rule + 1]; j++) {
        if (ruleTokens[j] !== token) found.push(ruleTokens[j])
      }
    }
    if (found.length === 0) return NO_SYNONYMS
    found.sort((a, b) => a - b)
    const synonyms: string[] = []
    let previous = -1
    for (const id of found) {
      if (synonyms.length === SYNONYMS_ADDED_PER_QUERY) break
      if (id === previous) continue
      previous = id
      synonyms.push(decoder.decode(blob.subarray(offsets[id], offsets[id + 1])))
    }
    return Object.freeze(synonyms)
  }

  const lookup: SynonymLookup = {
    tokenCount: tokens.length,
    bytes,
    expand: queryTokens => expandQuerySynonyms(lookup, queryTokens),
    synonymsOf(token: string): readonly string[] {
      const cached = cache.get(token)
      if (cached !== undefined) {
        cache.delete(token)
        cache.set(token, cached)
        return cached
      }
      const rankOfToken = rankOf(token)
      if (rankOfToken < 0) return NO_SYNONYMS
      const synonyms = collect(rankOfToken)
      if (cache.size >= SYNONYM_EXPANSION_CACHE_ENTRIES) {
        const oldest = cache.keys().next()
        if (oldest.done !== true) cache.delete(oldest.value)
      }
      cache.set(token, synonyms)
      return synonyms
    },
  }
  return lookup
}

export function buildSynonymLookup(
  rules: readonly SynonymRule[],
  analysis: SynonymAnalysis,
  raise: RaiseSynonymProblem | null,
): SynonymLookup | null {
  const analysed = new Map<string, string | number>()
  const interned: Interned = { ids: new Map(), tokens: [] }
  const ruleStart = new Uint32Array(rules.length + 1)
  const ruleTokenIds: number[] = []
  const ruleSource = new Int32Array(rules.length).fill(NO_SOURCE)
  const kept = new Uint8Array(rules.length)

  function tokenOf(word: string, rule: number): string | null {
    const result = analyseWord(word, analysis, analysed)
    if (typeof result === 'string') return result
    if (raise !== null) {
      const reason = result === 0 ? 'to no token, as a stop word does' : `to ${result} tokens, as a phrase does`
      raise(`Synonym rule ${rule} holds a word that the index analyses ${reason}`, { rule, tokens: result })
    }
    return null
  }

  for (let rule = 0; rule < rules.length; rule++) {
    const source = sourceWordOf(rules[rule])
    const sourceToken = source === undefined ? null : tokenOf(source, rule)
    const seen = new Set<number>()
    for (const word of targetWordsOf(rules[rule])) {
      const token = tokenOf(word, rule)
      if (token === null) continue
      const id = intern(interned, token)
      if (seen.has(id)) continue
      seen.add(id)
      ruleTokenIds.push(id)
    }
    if (source === undefined) kept[rule] = 1
    else if (sourceToken !== null) {
      ruleSource[rule] = intern(interned, sourceToken)
      kept[rule] = 1
    }
    if (kept[rule] === 0) ruleTokenIds.length = ruleStart[rule]
    ruleStart[rule + 1] = ruleTokenIds.length
  }

  if (ruleTokenIds.length === 0) return null
  return packedLookup(interned.tokens, ruleStart, ruleTokenIds, ruleSource)
}
