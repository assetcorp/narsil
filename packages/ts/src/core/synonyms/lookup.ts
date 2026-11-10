import type { SynonymRule } from '../../types/synonyms'
import { compareCodePoints } from '../ordering'
import { encodeStringBlob } from '../partition/frozen/string-blob'
import { tokenize } from '../tokenizer'
import { expandQuerySynonyms } from './expand'
import { synonymSelection } from './selection'
import type { RaiseSynonymProblem, SynonymAnalysis, SynonymLookup } from './types'

const NO_SOURCE = -1
const NO_SYNONYMS: readonly string[] = Object.freeze([])

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
  encodedRules: Uint8Array,
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

  const select = synonymSelection({
    tokens: blob,
    offsets,
    ruleStart,
    ruleSource: sources,
    ruleTokens,
    tokenStart: tokenRuleStart,
    tokenRules,
  })
  const bytes =
    blob.byteLength +
    offsets.byteLength +
    ruleStart.byteLength +
    ruleTokens.byteLength +
    sources.byteLength +
    tokenRuleStart.byteLength +
    tokenRules.byteLength

  const lookup: SynonymLookup = {
    encodedRules,
    tokenCount: tokens.length,
    bytes,
    expand: queryTokens => expandQuerySynonyms(select(queryTokens)),
    synonymsOf(token: string): readonly string[] {
      return select([token]).get(token) ?? NO_SYNONYMS
    },
  }
  return lookup
}

export function buildSynonymLookup(
  rules: readonly SynonymRule[],
  analysis: SynonymAnalysis,
  raise: RaiseSynonymProblem | null,
  encodedRules: Uint8Array,
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
  return packedLookup(interned.tokens, ruleStart, ruleTokenIds, ruleSource, encodedRules)
}
