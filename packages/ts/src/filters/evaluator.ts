import { bitsetAndInto, bitsetAndNotInto, bitsetOrInto, createBitSet } from '../core/bitset'
import { ErrorCodes, NarsilError } from '../errors'
import { parsedTypeOf } from '../schema/validator/field-type'
import type { FieldFilter, FilterExpression } from '../types/filters'
import { type FilterContext, narrowByFieldTests } from './field-tests'
import { FIELD_FILTER_OPERATORS, FILTER_EXPRESSION_KEYS } from './keys'
import { requireValidOperands, undeclaredFilterField } from './operands'

export type { FilterContext } from './field-tests'

const EXPRESSION_KEYS: ReadonlySet<string> = new Set(FILTER_EXPRESSION_KEYS)

const OPERATOR_KEYS: ReadonlySet<string> = new Set(FIELD_FILTER_OPERATORS)

function requireKnownKeys(value: object, known: ReadonlySet<string>, describe: (key: string) => string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new NarsilError(ErrorCodes.SEARCH_INVALID_FILTER, describe(key), { key })
    }
  }
}

class Narrowing {
  private readonly bits: Uint32Array

  constructor(universe: Uint32Array) {
    this.bits = universe.slice()
  }

  narrow = (matched: Uint32Array): void => {
    bitsetAndInto(this.bits, matched)
  }

  value(): Uint32Array {
    return this.bits
  }
}

function narrowByField(fieldPath: string, filter: FieldFilter, context: FilterContext, narrow: Narrowing): void {
  requireKnownKeys(
    filter,
    OPERATOR_KEYS,
    key => `Field "${fieldPath}" is tested with "${key}", which is no filter operator`,
  )
  const type = context.fieldTypes[fieldPath]
  const parsed = parsedTypeOf(type)
  if (type === undefined || parsed === undefined) throw undeclaredFilterField(fieldPath)
  const f = filter as Record<string, unknown>
  requireValidOperands(fieldPath, f, type)
  narrowByFieldTests(fieldPath, f, parsed, context, narrow.narrow)
}

export function evaluateFilters(expression: FilterExpression, context: FilterContext): Uint32Array {
  requireKnownKeys(
    expression,
    EXPRESSION_KEYS,
    key =>
      `A filter expression takes "fields", "and", "or", and "not", and "${key}" is none of them. A per-field test such as { ${key}: { eq: ... } } belongs under "fields"`,
  )

  const narrowing = new Narrowing(context.allDocIdsBitset)

  if (expression.fields) {
    for (const [fieldPath, filter] of Object.entries(expression.fields)) {
      narrowByField(fieldPath, filter, context, narrowing)
    }
  }

  if (expression.and?.length) {
    for (const nested of expression.and) narrowing.narrow(evaluateFilters(nested, context))
  }

  if (expression.or?.length) {
    const union = createBitSet(context.capacity)
    for (const nested of expression.or) bitsetOrInto(union, evaluateFilters(nested, context))
    narrowing.narrow(union)
  }

  if (expression.not) {
    const excluded = evaluateFilters(expression.not, context)
    const kept = context.allDocIdsBitset.slice()
    bitsetAndNotInto(kept, excluded)
    narrowing.narrow(kept)
  }

  return narrowing.value()
}
