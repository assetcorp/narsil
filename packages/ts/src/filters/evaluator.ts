import { evaluateFilter } from '#platform/filter-plan'
import { ErrorCodes, NarsilError } from '../errors'
import type { FilterExpression } from '../types/filters'
import type { FilterContext } from './context'
import { filterProgram } from './plan'

export type { FilterContext } from './context'

export function evaluateFilters(expression: FilterExpression, context: FilterContext): Uint32Array {
  const program = filterProgram(expression, context)
  const result = new Uint32Array(program.live.length)
  const status = evaluateFilter(program, result)
  if (status < 0) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The filter plan cannot be evaluated', { status })
  return result
}
