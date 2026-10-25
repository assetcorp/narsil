import { bitsetAndInto, bitsetAndNotInto, bitsetOrInto, createBitSet } from '../core/bitset'
import { parsedTypeOf } from '../schema/validator/field-type'
import type { FieldFilter, FilterExpression } from '../types/filters'
import { type FilterContext, narrowByFieldTests } from './field-tests'
import { requireValidatedFilter, undeclaredFilterField } from './operands'

export type { FilterContext } from './field-tests'

class Narrowing {
  private bits: Uint32Array | null = null

  narrow = (matched: Uint32Array): void => {
    if (this.bits === null) this.bits = matched.slice()
    else bitsetAndInto(this.bits, matched)
  }

  value(universe: () => Uint32Array): Uint32Array {
    return this.bits ?? universe().slice()
  }
}

function narrowByField(fieldPath: string, filter: FieldFilter, context: FilterContext, narrow: Narrowing): void {
  const parsed = parsedTypeOf(context.fieldTypes[fieldPath])
  if (parsed === undefined) throw undeclaredFilterField(fieldPath)
  narrowByFieldTests(fieldPath, filter as Record<string, unknown>, parsed, context, narrow.narrow)
}

function evaluateExpression(expression: FilterExpression, context: FilterContext): Uint32Array {
  const narrowing = new Narrowing()

  if (expression.fields) {
    for (const [fieldPath, filter] of Object.entries(expression.fields)) {
      narrowByField(fieldPath, filter, context, narrowing)
    }
  }

  if (expression.and?.length) {
    for (const nested of expression.and) narrowing.narrow(evaluateExpression(nested, context))
  }

  if (expression.or?.length) {
    const union = createBitSet(context.capacity)
    for (const nested of expression.or) bitsetOrInto(union, evaluateExpression(nested, context))
    narrowing.narrow(union)
  }

  if (expression.not) {
    const excluded = evaluateExpression(expression.not, context)
    const kept = context.allDocIdsBitset.slice()
    bitsetAndNotInto(kept, excluded)
    narrowing.narrow(kept)
  }

  return narrowing.value(() => context.allDocIdsBitset)
}

export function evaluateFilters(expression: FilterExpression, context: FilterContext): Uint32Array {
  requireValidatedFilter(expression, context.fieldTypes)
  return evaluateExpression(expression, context)
}
