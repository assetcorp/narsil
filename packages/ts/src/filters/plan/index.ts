import { FILTER_AND, FILTER_NOT, FILTER_OR, type FilterProgram } from '../../core/filters/layout'
import { parsedTypeOf } from '../../schema/validator/field-type'
import type { FilterExpression } from '../../types/filters'
import type { FilterContext } from '../context'
import { undeclaredFilterField, validatedFilterOf } from '../operands'
import { FilterBuilder } from './builder'
import { fieldPlan } from './fields'

function expressionPlan(expression: FilterExpression, builder: FilterBuilder): void {
  let count = 0
  function append(): void {
    if (count++ !== 0) builder.emit(FILTER_AND, 0, 0, 2)
  }
  for (const [path, filter] of Object.entries(expression.fields ?? {})) {
    const parsed = parsedTypeOf(builder.context.fieldTypes[path])
    if (parsed === undefined) throw undeclaredFilterField(path)
    fieldPlan(builder, path, filter as Record<string, unknown>, parsed)
    append()
  }
  for (const nested of expression.and ?? []) {
    expressionPlan(nested, builder)
    append()
  }
  let alternatives = 0
  for (const nested of expression.or ?? []) {
    expressionPlan(nested, builder)
    if (alternatives++ !== 0) builder.emit(FILTER_OR, 0, 0, 2)
  }
  if (alternatives > 0) append()
  if (expression.not !== undefined) {
    expressionPlan(expression.not, builder)
    builder.emit(FILTER_NOT)
    append()
  }
  if (count === 0) builder.bitset(builder.context.allDocIdsBitset)
}

export function filterProgram(expression: FilterExpression, context: FilterContext): FilterProgram {
  const builder = new FilterBuilder(context)
  expressionPlan(validatedFilterOf(expression, context.fieldTypes), builder)
  return builder.finish()
}
