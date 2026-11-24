import {
  compareCodePoints,
  foldedSpellingSinks,
  fuzzyPrefixOf,
  fuzzyTermMatches,
} from '../../engine/optional-reads-host-bindings'
import type { PartitionReadState } from '../partition/read-state'
import { type FoldedSpelling, type FoldingRules, foldedSpelling, foldText } from './keys'

interface SpellingEntry extends FoldedSpelling {
  readonly tokens: string[]
}

export interface SpellingRef {
  readonly spelling: string
  readonly token: string
}

function addTo(lists: Map<string, string[]>, key: string, spelling: string): boolean {
  const held = lists.get(key)
  if (held !== undefined) {
    held.push(spelling)
    return false
  }
  lists.set(key, [spelling])
  return true
}

function lowerBoundOf(sorted: readonly string[], wanted: string): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareCodePoints(sorted[middle], wanted) < 0) low = middle + 1
    else high = middle
  }
  return low
}

export class SegmentFoldIndex {
  readonly rules: FoldingRules
  private readonly entries = new Map<string, SpellingEntry>()
  private readonly byKey = new Map<string, string[]>()
  private readonly byFold = new Map<string, string[]>()
  private sortedKeys: string[] | null = null
  private sortedFolds: string[] | null = null

  constructor(rules: FoldingRules) {
    this.rules = rules
  }

  note(spelling: string, token: string): void {
    const held = this.entries.get(spelling)
    if (held !== undefined) {
      if (!held.tokens.includes(token)) held.tokens.push(token)
      return
    }
    if (foldText(spelling, this.rules) === spelling) return
    const { fold, key } = foldedSpelling(spelling, this.rules)
    this.entries.set(spelling, { fold, key, tokens: [token] })
    if (addTo(this.byKey, key, spelling)) this.sortedKeys = null
    if (addTo(this.byFold, fold, spelling)) this.sortedFolds = null
  }

  refsWithKey(key: string, visit: (ref: SpellingRef) => void): void {
    for (const spelling of this.byKey.get(key) ?? []) this.visitRefs(spelling, visit)
  }

  refsNearKey(key: string, tolerance: number, prefixLength: number, visit: (ref: SpellingRef) => void): void {
    this.sortedKeys ??= [...this.byKey.keys()].sort(compareCodePoints)
    const keys = this.sortedKeys
    const shared = fuzzyPrefixOf(key, prefixLength)
    for (let at = lowerBoundOf(keys, shared); at < keys.length && keys[at].startsWith(shared); at++) {
      if (fuzzyTermMatches(key, keys[at], tolerance, prefixLength)) this.refsWithKey(keys[at], visit)
    }
  }

  refsWithFoldPrefix(prefix: string, visit: (ref: SpellingRef) => void): void {
    this.sortedFolds ??= [...this.byFold.keys()].sort(compareCodePoints)
    const folds = this.sortedFolds
    for (let at = lowerBoundOf(folds, prefix); at < folds.length && folds[at].startsWith(prefix); at++) {
      for (const spelling of this.byFold.get(folds[at]) ?? []) this.visitRefs(spelling, visit)
    }
  }

  private visitRefs(spelling: string, visit: (ref: SpellingRef) => void): void {
    for (const token of this.entries.get(spelling)?.tokens ?? []) visit({ spelling, token })
  }
}

export function spellingIsHeld(state: PartitionReadState, ref: SpellingRef): boolean {
  if (ref.spelling !== ref.token) {
    const form = state.surfaceRegistry.formOf(ref.spelling)
    return form !== undefined && form.token === ref.token
  }
  const list = state.invertedIdx.lookup(ref.token)
  if (list === undefined) return false
  return list.totalTermFrequency - state.surfaceRegistry.stemChangedTotalFor(ref.token) > 0
}

function buildFoldIndex(state: PartitionReadState, rules: FoldingRules): SegmentFoldIndex {
  const index = new SegmentFoldIndex(rules)
  const forms = state.surfaceRegistry.serialize()
  for (const surface of Object.keys(forms)) {
    const form = forms[surface]
    if (Array.isArray(form) && form[0] > 0) index.note(surface, form[1])
  }
  for (const token of state.invertedIdx.tokens()) index.note(token, token)
  return index
}

const indexes = new WeakMap<PartitionReadState, SegmentFoldIndex>()

export function foldIndexOf(state: PartitionReadState, rules: FoldingRules): SegmentFoldIndex {
  const held = indexes.get(state)
  if (held !== undefined && held.rules === rules) return held
  const built = buildFoldIndex(state, rules)
  indexes.set(state, built)
  foldedSpellingSinks.set(state, built)
  return built
}
