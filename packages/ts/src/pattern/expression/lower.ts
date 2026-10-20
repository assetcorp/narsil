import type { PatternHost } from '../../core/pattern-index/types'
import { ANY_CODE_POINT, ANY_CONTEXT_MASK, type CodePointTest, TESTED_CODE_POINT } from '../automaton'
import type { PatternNode } from './ast'
import { classTest, distinctMultiFolds, setTest } from './code-point-tests'

export type Plan =
  | { readonly kind: 'consume'; readonly literal: number; readonly test: CodePointTest | null }
  | { readonly kind: 'assert'; readonly mask: number }
  | { readonly kind: 'sequence'; readonly items: readonly Plan[] }
  | { readonly kind: 'choice'; readonly branches: readonly Plan[] }
  | { readonly kind: 'repeat'; readonly body: Plan; readonly min: number; readonly max: number | null }

const EMPTY: Plan = { kind: 'assert', mask: ANY_CONTEXT_MASK }

function literalPlan(codePoint: number): Plan {
  return { kind: 'consume', literal: codePoint, test: null }
}

function testedPlan(test: CodePointTest): Plan {
  return { kind: 'consume', literal: TESTED_CODE_POINT, test }
}

function sequenceOf(items: readonly Plan[]): Plan {
  const kept: Plan[] = []
  let mask = ANY_CONTEXT_MASK
  const flushMask = (): void => {
    if (mask !== ANY_CONTEXT_MASK) kept.push({ kind: 'assert', mask })
    mask = ANY_CONTEXT_MASK
  }
  const visit = (item: Plan): void => {
    if (item.kind === 'sequence') {
      for (const nested of item.items) visit(nested)
    } else if (item.kind === 'assert') {
      mask &= item.mask
    } else {
      flushMask()
      kept.push(item)
    }
  }
  for (const item of items) visit(item)
  if (kept.length === 0) return { kind: 'assert', mask }
  flushMask()
  return kept.length === 1 ? kept[0] : { kind: 'sequence', items: kept }
}

function choiceOf(branches: readonly Plan[]): Plan {
  const kept: Plan[] = []
  let mask = 0
  let empty = false
  const visit = (branch: Plan): void => {
    if (branch.kind === 'choice') {
      for (const nested of branch.branches) visit(nested)
    } else if (branch.kind === 'assert') {
      mask |= branch.mask
      empty = true
    } else {
      kept.push(branch)
    }
  }
  for (const branch of branches) visit(branch)
  if (kept.length === 0) return { kind: 'assert', mask }
  if (empty) kept.push({ kind: 'assert', mask })
  return kept.length === 1 ? kept[0] : { kind: 'choice', branches: kept }
}

function isLoose(plan: Plan): plan is Extract<Plan, { kind: 'repeat' }> {
  return plan.kind === 'repeat' && plan.min <= 1 && (plan.max === null || plan.max === 1)
}

function repeatOf(body: Plan, min: number, max: number | null): Plan {
  if (max === 0) return EMPTY
  if (body.kind === 'assert') return min === 0 ? EMPTY : body
  if (min === 1 && max === 1) return body
  const loose = min <= 1 && (max === null || max === 1)
  if (loose && isLoose(body)) {
    const nullable = min === 0 || body.min === 0
    const unbounded = max === null || body.max === null
    return { kind: 'repeat', body: body.body, min: nullable ? 0 : 1, max: unbounded ? null : 1 }
  }
  return { kind: 'repeat', body, min, max }
}

function foldedLiteral(codePoint: number, host: PatternHost, scratch: number[]): Plan {
  scratch.length = 0
  host.appendFoldedCodePoint(codePoint, scratch)
  return sequenceOf(scratch.map(literalPlan))
}

function setPlan(node: Extract<PatternNode, { kind: 'set' }>, caseFold: boolean, host: PatternHost): Plan {
  const single = testedPlan(setTest(node.items, node.negated, caseFold, host))
  if (!caseFold || node.negated) return single
  const sequences = distinctMultiFolds(node.items, host).map(fold => sequenceOf(fold.map(literalPlan)))
  return sequences.length === 0 ? single : choiceOf([single, ...sequences])
}

function lowerNode(node: PatternNode, caseFold: boolean, host: PatternHost, scratch: number[]): Plan {
  switch (node.kind) {
    case 'literal':
      return caseFold ? foldedLiteral(node.codePoint, host, scratch) : literalPlan(node.codePoint)
    case 'any':
      return literalPlan(ANY_CODE_POINT)
    case 'class':
      return testedPlan(classTest(node.name))
    case 'set':
      return setPlan(node, caseFold, host)
    case 'assert':
      return node
    case 'sequence':
      return sequenceOf(node.items.map(item => lowerNode(item, caseFold, host, scratch)))
    case 'choice':
      return choiceOf(node.branches.map(branch => lowerNode(branch, caseFold, host, scratch)))
    case 'repeat':
      return repeatOf(lowerNode(node.body, caseFold, host, scratch), node.min, node.max)
    case 'numberRange':
      return lowerNode(node.expansion, caseFold, host, scratch)
  }
}

export function lowerPattern(node: PatternNode, caseFold: boolean, host: PatternHost): Plan {
  return lowerNode(node, caseFold, host, [])
}
