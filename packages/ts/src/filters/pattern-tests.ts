import { bitsetAnd, bitsetNot, bitsetOr, createBitSet } from '../core/bitset'
import type { PatternOperator } from '../core/pattern-index/types'

export interface PatternFilterContext {
  isPatternField(fieldPath: string): boolean
  patternBitset(fieldPath: string, operator: PatternOperator, text: string, caseFold: boolean): Uint32Array
  patternValuesBitset(fieldPath: string): Uint32Array
  readonly capacity: number
  readonly allDocIdsBitset: Uint32Array
}

function unionOf(bitsets: readonly Uint32Array[], capacity: number): Uint32Array {
  let union = createBitSet(capacity)
  for (const bitset of bitsets) union = bitsetOr(union, bitset)
  return union
}

function excluding(context: PatternFilterContext, fieldPath: string, excluded: Uint32Array): Uint32Array {
  const universe = bitsetAnd(context.patternValuesBitset(fieldPath), context.allDocIdsBitset)
  return bitsetAnd(universe, bitsetNot(excluded, context.capacity))
}

function textsOf(operand: unknown): string[] {
  return Array.isArray(operand) ? operand.filter((text): text is string => typeof text === 'string') : []
}

export function evaluatePatternTests(
  fieldPath: string,
  filter: Record<string, unknown>,
  context: PatternFilterContext,
  bitsets: Uint32Array[],
): void {
  const caseFold = filter.caseFold === true
  const test = (operator: PatternOperator, text: string): Uint32Array =>
    context.patternBitset(fieldPath, operator, text, caseFold)
  const testEvery = (texts: readonly string[]): Uint32Array =>
    unionOf(
      texts.map(text => test('eq', text)),
      context.capacity,
    )

  if (typeof filter.eq === 'string') bitsets.push(test('eq', filter.eq))
  if (typeof filter.ne === 'string') bitsets.push(excluding(context, fieldPath, test('eq', filter.ne)))
  if (filter.in !== undefined) bitsets.push(testEvery(textsOf(filter.in)))
  if (filter.nin !== undefined) bitsets.push(excluding(context, fieldPath, testEvery(textsOf(filter.nin))))
  if (typeof filter.startsWith === 'string') bitsets.push(test('startsWith', filter.startsWith))
  if (typeof filter.endsWith === 'string') bitsets.push(test('endsWith', filter.endsWith))
  if (typeof filter.contains === 'string') bitsets.push(test('contains', filter.contains))
}
