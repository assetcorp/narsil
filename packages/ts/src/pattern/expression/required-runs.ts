import { PATTERN_RUN_CODE_POINTS } from '../../core/pattern-index/constants'
import type { PatternHost } from '../../core/pattern-index/types'
import { SHORTLIST_RUN_LOOKUPS } from '../constants'
import { runKey } from '../text'
import type { PatternNode } from './ast'

export type RunQuery =
  | { readonly kind: 'all'; readonly runs: Uint32Array }
  | { readonly kind: 'any'; readonly branches: readonly Uint32Array[] }

const NO_RUNS = new Uint32Array(0)

class FactorCollector {
  readonly factors: number[][] = []
  private current: number[] = []

  constructor(private readonly host: PatternHost) {}

  flush(): void {
    if (this.current.length >= PATTERN_RUN_CODE_POINTS) this.factors.push(this.current)
    this.current = []
  }

  visit(node: PatternNode): void {
    switch (node.kind) {
      case 'literal':
        this.host.appendFoldedCodePoint(node.codePoint, this.current)
        return
      case 'assert':
        return
      case 'sequence':
        for (const item of node.items) this.visit(item)
        return
      case 'repeat':
        if (node.min === 1 && node.max === 1) {
          this.visit(node.body)
          return
        }
        this.flush()
        if (node.min >= 1) {
          this.visit(node.body)
          this.flush()
        }
        return
      default:
        this.flush()
    }
  }
}

export function spreadRuns(factors: readonly (readonly number[])[]): Uint32Array {
  let total = 0
  for (const factor of factors) total += Math.max(0, factor.length - PATTERN_RUN_CODE_POINTS + 1)
  if (total === 0) return NO_RUNS
  const picks = Math.min(total, SHORTLIST_RUN_LOOKUPS)
  const seen = new Set<string>()
  const runs: number[] = []
  let factorAt = 0
  let factorStart = 0
  for (let pick = 0; pick < picks; pick++) {
    const target = picks === 1 ? 0 : Math.round((pick * (total - 1)) / (picks - 1))
    let factorRuns = Math.max(0, factors[factorAt].length - PATTERN_RUN_CODE_POINTS + 1)
    while (target >= factorStart + factorRuns) {
      factorStart += factorRuns
      factorAt++
      factorRuns = Math.max(0, factors[factorAt].length - PATTERN_RUN_CODE_POINTS + 1)
    }
    const factor = factors[factorAt]
    const at = target - factorStart
    const key = runKey(factor[at], factor[at + 1], factor[at + 2])
    if (seen.has(key)) continue
    seen.add(key)
    runs.push(factor[at], factor[at + 1], factor[at + 2])
  }
  return Uint32Array.from(runs)
}

function branchRuns(node: PatternNode, host: PatternHost): Uint32Array {
  const collector = new FactorCollector(host)
  collector.visit(node)
  collector.flush()
  return spreadRuns(collector.factors)
}

export function requiredRuns(node: PatternNode, host: PatternHost): RunQuery {
  if (node.kind !== 'choice') return { kind: 'all', runs: branchRuns(node, host) }
  const branches = node.branches.map(branch => branchRuns(branch, host))
  if (branches.some(runs => runs.length === 0)) return { kind: 'all', runs: NO_RUNS }
  return { kind: 'any', branches }
}
