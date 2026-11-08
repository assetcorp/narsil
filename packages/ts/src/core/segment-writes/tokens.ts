import type { NativeFieldTokens, NativeGrowingSegment, NativeSurfaceTable } from '../../vector/native/types/segments'
import { storedText } from '../stored-values/text'
import { requireRoom } from './status'
import { addCount, findString, StringPlan } from './strings'

export interface TokenRef {
  term: number
  field: number
  position: number
}

function pointCount(text: string): number {
  let count = 0
  for (const _point of text) count++
  return count
}

function textAt(field: NativeFieldTokens, at: number, cache: Map<number, string>): string {
  const start = field.tokens[at]
  const length = field.tokens[at + 1]
  const held = cache.get(start)
  if (held !== undefined && held.length === length) return held
  const text = storedText(field.units, start, length)
  cache.set(start, text)
  return text
}

function orderTokens(tokens: TokenRef[], terms: number): TokenRef[] {
  const starts = new Uint32Array(terms)
  for (const token of tokens) starts[token.term]++
  let end = 0
  for (let term = 0; term < starts.length; term++) {
    const count = starts[term]
    starts[term] = end
    end += count
  }
  const ordered = new Array<TokenRef>(tokens.length)
  for (const token of tokens) ordered[starts[token.term]++] = token
  for (let at = 1; at < ordered.length; at++) {
    const previous = ordered[at - 1]
    const current = ordered[at]
    if (previous.term !== current.term || previous.field !== current.field || previous.position <= current.position)
      continue
    ordered.sort((left, right) => left.term - right.term || left.field - right.field || left.position - right.position)
    break
  }
  return ordered
}

export class TokenPlan {
  readonly terms: StringPlan
  readonly surfaces: StringPlan | null
  readonly spellings: StringPlan | null
  readonly tokens: TokenRef[] = []

  constructor(
    readonly segment: NativeGrowingSegment,
    fields: readonly NativeFieldTokens[],
    removing: boolean,
  ) {
    this.terms = new StringPlan(segment.terms)
    this.surfaces = segment.surfaces === null ? null : new StringPlan(segment.surfaces.strings)
    this.spellings = segment.spellings === null ? null : new StringPlan(segment.spellings.strings)
    for (const field of fields) {
      const text = new Map<number, string>()
      for (let at = 0; at < field.tokens.length; at += 8) this.add(field, at, removing, text)
    }
    if (removing) return
    this.terms.check()
    this.surfaces?.check()
    this.spellings?.check()
    this.tokens = orderTokens(this.tokens, this.terms.entries.length)
  }

  private count(plan: StringPlan, table: NativeSurfaceTable, text: string, token: number, removing: boolean): void {
    if (removing && findString(table.strings, text) < 0) return
    const entry = plan.prepare(text)
    if (entry.count === 0) {
      entry.token = entry.added ? token : table.token[entry.ordinal]
      entry.points = plan === this.spellings ? pointCount(text) : 0
    }
    addCount(entry, removing || entry.added ? 0 : table.count[entry.ordinal], 1)
  }

  private add(field: NativeFieldTokens, at: number, removing: boolean, cache: Map<number, string>): void {
    const record = field.tokens
    const text = textAt(field, at + 1, cache)
    if (removing && findString(this.segment.terms, text) < 0) return
    const term = this.terms.prepare(text)
    let spelling = text
    if (record[at + 3] !== 0xffffffff && record[at + 4] > 0) {
      spelling = textAt(field, at + 3, cache)
      if (spelling !== text) {
        if (this.surfaces === null || this.segment.surfaces === null) requireRoom(removing)
        else this.count(this.surfaces, this.segment.surfaces, spelling, term.ordinal, removing)
      }
    }
    if (
      this.segment.partialFields[field.field] !== 0 &&
      this.spellings !== null &&
      this.segment.spellings !== null &&
      pointCount(spelling) > 3
    )
      this.count(this.spellings, this.segment.spellings, spelling, term.ordinal, removing)
    if (!removing) this.tokens.push({ term: term.index, field: field.field, position: record[at] })
  }
}
