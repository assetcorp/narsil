import { bitsetAnd, bitsetNot, createBitSet } from '../core/bitset'
import type { PatternOperator } from '../core/pattern-index/types'

export interface PatternFilterContext {
  isPatternField(fieldPath: string): boolean
  matchPattern(fieldPath: string, operator: PatternOperator, text: string, caseFold: boolean, into: Uint32Array): void
  presentBitset(fieldPath: string): Uint32Array
  readonly capacity: number
  readonly allDocIdsBitset: Uint32Array
}

function excluding(context: PatternFilterContext, fieldPath: string, excluded: Uint32Array): Uint32Array {
  const universe = bitsetAnd(context.presentBitset(fieldPath), context.allDocIdsBitset)
  return bitsetAnd(universe, bitsetNot(excluded, context.capacity))
}

function textsOf(operand: unknown): Set<string> {
  const texts = new Set<string>()
  if (!Array.isArray(operand)) return texts
  for (const text of operand) if (typeof text === 'string') texts.add(text)
  return texts
}

export function evaluatePatternTests(
  fieldPath: string,
  filter: Record<string, unknown>,
  context: PatternFilterContext,
  bitsets: Uint32Array[],
): void {
  const caseFold = filter.caseFold === true
  const matching = (operator: PatternOperator, texts: Iterable<string>): Uint32Array => {
    const into = createBitSet(context.capacity)
    for (const text of texts) context.matchPattern(fieldPath, operator, text, caseFold, into)
    return into
  }

  if (typeof filter.eq === 'string') bitsets.push(matching('eq', [filter.eq]))
  if (typeof filter.ne === 'string') bitsets.push(excluding(context, fieldPath, matching('eq', [filter.ne])))
  if (filter.in !== undefined) bitsets.push(matching('eq', textsOf(filter.in)))
  if (filter.nin !== undefined) bitsets.push(excluding(context, fieldPath, matching('eq', textsOf(filter.nin))))
  if (typeof filter.startsWith === 'string') bitsets.push(matching('startsWith', [filter.startsWith]))
  if (typeof filter.endsWith === 'string') bitsets.push(matching('endsWith', [filter.endsWith]))
  if (typeof filter.contains === 'string') bitsets.push(matching('contains', [filter.contains]))
}
