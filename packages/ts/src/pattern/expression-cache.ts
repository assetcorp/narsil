import type { ExpressionOperator, PatternHost, PatternWorkMeter } from '../core/pattern-index/types'
import type { PatternProgram } from './automaton'
import { KEPT_PROGRAM_BUDGET_FRACTION } from './constants'
import { buildProgram, type PreparedExpression, prepareExpression } from './expression'
import { LazyDfa } from './lazy-dfa'

interface CachedExpression {
  readonly key: string
  readonly prepared: PreparedExpression
  program: PatternProgram | null
}

class SearchExpressions {
  private readonly entries = new Map<string, CachedExpression>()
  private keptProgramBytes = 0
  private current: { readonly key: string; readonly dfa: LazyDfa } | null = null

  constructor(private readonly budgetBytes: number) {}

  expression(operator: ExpressionOperator, text: string, caseFold: boolean, host: PatternHost): CachedExpression {
    const key = `${operator}\u0000${caseFold ? 1 : 0}\u0000${text}`
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = { key, prepared: prepareExpression(operator, text, caseFold, host), program: null }
      this.entries.set(key, entry)
    }
    return entry
  }

  matcher(entry: CachedExpression): LazyDfa {
    if (this.current?.key === entry.key) return this.current.dfa
    this.current = null
    const program = entry.program ?? this.programOf(entry)
    const othersBytes = this.keptProgramBytes - (entry.program === null ? 0 : program.bytes)
    const dfa = new LazyDfa(program, this.budgetBytes - othersBytes)
    this.current = { key: entry.key, dfa }
    return dfa
  }

  private programOf(entry: CachedExpression): PatternProgram {
    const program = buildProgram(entry.prepared)
    if (this.keptProgramBytes + program.bytes <= this.budgetBytes * KEPT_PROGRAM_BUDGET_FRACTION) {
      entry.program = program
      this.keptProgramBytes += program.bytes
    }
    return program
  }
}

const expressionsBySearch = new WeakMap<PatternWorkMeter, SearchExpressions>()

export function searchExpressions(meter: PatternWorkMeter): SearchExpressions {
  let expressions = expressionsBySearch.get(meter)
  if (expressions === undefined) {
    expressions = new SearchExpressions(meter.matcherStateBytes)
    expressionsBySearch.set(meter, expressions)
  }
  return expressions
}
