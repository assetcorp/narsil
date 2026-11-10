import type { NativeGrowingSegment, NativeSurfaceTable } from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'
import { WRITE_PLAN_START_CAPACITY } from './constants'
import { PREPARED_ROW_WORDS } from './prepared-tokens'
import { requireRoom } from './status'
import { StampedMemo } from './string-memo'
import { addCount, StringPlan } from './strings'
import { PreparedSource, type TokenSource } from './token-sources'

export const TOKEN_REFERENCE_WORDS = 3
const ABSENT_TEXT = 0xffffffff
function pointCount(text: string): number {
  let count = text.length
  for (let at = 0; at + 1 < text.length; at++) {
    const unit = text.charCodeAt(at)
    if (unit < 0xd800 || unit >= 0xdc00) continue
    const next = text.charCodeAt(at + 1)
    if (next < 0xdc00 || next >= 0xe000) continue
    count--
    at++
  }
  return count
}

const termMemo = new StampedMemo()
const surfaceMemo = new StampedMemo()

function remembered(
  plan: StringPlan,
  memo: StampedMemo | null,
  key: number,
  text: string,
  removing: boolean,
  indexed: boolean,
): number {
  if (memo !== null) {
    const held = memo.get(key)
    if (held >= 0 && held < plan.size && plan.texts[held] === text) return held
  }
  const prepared = removing ? plan.prepareExisting(text, indexed) : plan.prepare(text, indexed)
  if (memo !== null && prepared >= 0) memo.set(key, prepared)
  return prepared
}

function sortReferences(references: Uint32Array, count: number): Uint32Array {
  const order = Array.from({ length: count }, (_, at) => at * TOKEN_REFERENCE_WORDS)
  order.sort(
    (left, right) =>
      references[left] - references[right] ||
      references[left + 1] - references[right + 1] ||
      references[left + 2] - references[right + 2],
  )
  const sorted = new Uint32Array(count * TOKEN_REFERENCE_WORDS)
  for (let at = 0; at < count; at++)
    sorted.set(references.subarray(order[at], order[at] + TOKEN_REFERENCE_WORDS), at * TOKEN_REFERENCE_WORDS)
  return sorted
}

function grown(held: Uint32Array, needed: number): Uint32Array {
  if (needed <= held.length) return held
  let capacity = held.length
  while (capacity < needed) capacity *= 2
  return new Uint32Array(capacity)
}

function reusedPlan(held: StringPlan | null, table: NativeTermTable): StringPlan {
  return held === null ? new StringPlan(table) : held.reset(table)
}

export class TokenPlan {
  segment: NativeGrowingSegment
  terms: StringPlan
  surfaces: StringPlan | null = null
  spellings: StringPlan | null = null
  tokens: Uint32Array = new Uint32Array(WRITE_PLAN_START_CAPACITY * TOKEN_REFERENCE_WORDS)
  count = 0
  private references: Uint32Array = new Uint32Array(WRITE_PLAN_START_CAPACITY * TOKEN_REFERENCE_WORDS)
  private starts: Uint32Array = new Uint32Array(WRITE_PLAN_START_CAPACITY)
  private surfacePlan: StringPlan | null = null
  private spellingPlan: StringPlan | null = null
  private indexed = true

  constructor(segment: NativeGrowingSegment) {
    this.segment = segment
    this.terms = new StringPlan(segment.terms)
  }

  prepare(segment: NativeGrowingSegment, sources: readonly TokenSource[], removing: boolean): this {
    this.segment = segment
    this.terms.reset(segment.terms)
    this.surfaces = null
    this.spellings = null
    if (segment.surfaces !== null) {
      this.surfacePlan = reusedPlan(this.surfacePlan, segment.surfaces.strings)
      this.surfaces = this.surfacePlan
    }
    if (segment.spellings !== null) {
      this.spellingPlan = reusedPlan(this.spellingPlan, segment.spellings.strings)
      this.spellings = this.spellingPlan
    }
    this.count = 0
    let records = 0
    for (const source of sources) records += source.records
    if (!removing) this.references = grown(this.references, records * TOKEN_REFERENCE_WORDS)
    const first = sources[0]
    this.indexed = !sources.every(source => source.textKeys && source.keyScope === first?.keyScope)
    let keyScope: object | null = null
    for (const source of sources) {
      if (source.keyScope !== keyScope) {
        keyScope = source.keyScope
        termMemo.claim(this, source.keys)
        surfaceMemo.claim(this, source.keys)
      }
      if (source instanceof PreparedSource) this.addPrepared(source, removing)
      else
        for (let record = 0; record < source.records; record++)
          this.add(
            source.field,
            source.term(record),
            source.termKey(record),
            source.surface(record),
            source.surfaceKey(record),
            source.position(record),
            removing,
          )
    }
    if (removing) return this
    this.terms.check()
    this.surfaces?.check()
    this.spellings?.check()
    this.orderReferences()
    return this
  }

  private orderReferences(): void {
    const count = this.count
    const references = this.references
    const terms = this.terms.size
    this.starts = grown(this.starts, terms)
    const starts = this.starts
    starts.fill(0, 0, terms)
    for (let at = 0; at < count; at++) starts[references[at * TOKEN_REFERENCE_WORDS]]++
    let end = 0
    for (let term = 0; term < terms; term++) {
      const held = starts[term]
      starts[term] = end
      end += held
    }
    this.tokens = grown(this.tokens, count * TOKEN_REFERENCE_WORDS)
    const ordered = this.tokens
    for (let at = 0; at < count * TOKEN_REFERENCE_WORDS; at += TOKEN_REFERENCE_WORDS) {
      const target = starts[references[at]]++ * TOKEN_REFERENCE_WORDS
      ordered[target] = references[at]
      ordered[target + 1] = references[at + 1]
      ordered[target + 2] = references[at + 2]
    }
    for (let at = TOKEN_REFERENCE_WORDS; at < count * TOKEN_REFERENCE_WORDS; at += TOKEN_REFERENCE_WORDS) {
      if (ordered[at - 3] !== ordered[at] || ordered[at - 2] !== ordered[at + 1] || ordered[at - 1] <= ordered[at + 2])
        continue
      this.tokens = sortReferences(ordered, count)
      return
    }
  }

  private countSpelling(
    plan: StringPlan,
    table: NativeSurfaceTable,
    text: string,
    token: number,
    removing: boolean,
    memo: StampedMemo | null,
    key: number,
  ): void {
    const at = remembered(plan, memo, key, text, removing, memo === null || this.indexed)
    if (at < 0) return
    const added = plan.added[at] === 1
    if (plan.counts[at] === 0) {
      plan.tokens[at] = added ? token : table.token[plan.ordinals[at]]
      plan.points[at] = plan === this.spellings ? pointCount(text) : 0
    }
    addCount(plan, at, removing || added ? 0 : table.count[plan.ordinals[at]], 1)
  }

  private addPrepared(source: PreparedSource, removing: boolean): void {
    const { field, texts, rows } = source
    const terms = this.terms
    const surfaces = this.surfaces
    const surfaceTable = this.segment.surfaces
    const spellings = this.spellings
    const spellingTable = this.segment.spellings
    const partial = this.segment.partialFields[field] !== 0 && spellings !== null && spellingTable !== null
    const indexed = this.indexed
    const references = this.references
    let reference = this.count * TOKEN_REFERENCE_WORDS
    const end = source.records * PREPARED_ROW_WORDS
    for (let row = 0; row < end; row += PREPARED_ROW_WORDS) {
      const termId = rows[row]
      const text = texts[termId]
      let term = termMemo.get(termId)
      if (term < 0 || term >= terms.size || terms.texts[term] !== text) {
        term = removing ? terms.prepareExisting(text, indexed) : terms.prepare(text, indexed)
        if (term < 0) continue
        termMemo.set(termId, term)
      }
      const surfaceId = rows[row + 1]
      let spelling = text
      if (surfaceId !== ABSENT_TEXT && surfaceId !== termId) {
        const surface = texts[surfaceId]
        if (surface !== '' && surface !== text) {
          spelling = surface
          if (surfaces === null || surfaceTable === null) requireRoom(removing)
          else
            this.countSpelling(surfaces, surfaceTable, surface, terms.ordinals[term], removing, surfaceMemo, surfaceId)
        }
      }
      if (partial && pointCount(spelling) > 3)
        this.countSpelling(spellings, spellingTable, spelling, terms.ordinals[term], removing, null, 0)
      if (removing) continue
      references[reference] = term
      references[reference + 1] = field
      references[reference + 2] = rows[row + 2]
      reference += TOKEN_REFERENCE_WORDS
    }
    this.count = reference / TOKEN_REFERENCE_WORDS
  }

  private add(
    field: number,
    text: string,
    termKey: number,
    surface: string | undefined,
    surfaceKey: number,
    position: number,
    removing: boolean,
  ): void {
    const term = remembered(this.terms, termMemo, termKey, text, removing, this.indexed)
    if (term < 0) return
    const ordinal = this.terms.ordinals[term]
    let spelling = text
    if (surface !== undefined) {
      spelling = surface
      if (spelling !== text) {
        if (this.surfaces === null || this.segment.surfaces === null) requireRoom(removing)
        else
          this.countSpelling(this.surfaces, this.segment.surfaces, spelling, ordinal, removing, surfaceMemo, surfaceKey)
      }
    }
    if (
      this.segment.partialFields[field] !== 0 &&
      this.spellings !== null &&
      this.segment.spellings !== null &&
      pointCount(spelling) > 3
    )
      this.countSpelling(this.spellings, this.segment.spellings, spelling, ordinal, removing, null, 0)
    if (removing) return
    const reference = this.count++ * TOKEN_REFERENCE_WORDS
    this.references[reference] = term
    this.references[reference + 1] = field
    this.references[reference + 2] = position
  }
}

let spareTokenPlan: TokenPlan | null = null

export function acquireTokenPlan(
  segment: NativeGrowingSegment,
  sources: readonly TokenSource[],
  removing: boolean,
): TokenPlan {
  const plan = spareTokenPlan ?? new TokenPlan(segment)
  spareTokenPlan = null
  try {
    return plan.prepare(segment, sources, removing)
  } catch (error) {
    spareTokenPlan = plan
    throw error
  }
}

export function releaseTokenPlan(plan: TokenPlan): void {
  spareTokenPlan = plan
}
