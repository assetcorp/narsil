import { MAX_PATTERN_POSITIONS } from '../../core/pattern-index/constants'
import type { PatternHost } from '../../core/pattern-index/types'
import type { PatternNode } from './ast'
import { distinctMultiFolds } from './code-point-tests'

const SATURATED = MAX_PATTERN_POSITIONS + 1

function saturating(total: number): number {
  return Math.min(total, SATURATED)
}

function literalPositions(codePoint: number, caseFold: boolean, host: PatternHost, scratch: number[]): number {
  if (!caseFold) return 1
  scratch.length = 0
  host.appendFoldedCodePoint(codePoint, scratch)
  return scratch.length
}

function positionsOf(node: PatternNode, caseFold: boolean, host: PatternHost, scratch: number[]): number {
  switch (node.kind) {
    case 'literal':
      return literalPositions(node.codePoint, caseFold, host, scratch)
    case 'any':
    case 'class':
      return 1
    case 'set': {
      if (!caseFold || node.negated) return 1
      let total = 1
      for (const fold of distinctMultiFolds(node.items, host)) total = saturating(total + fold.length)
      return total
    }
    case 'assert':
      return 0
    case 'sequence':
    case 'choice': {
      let total = 0
      const children = node.kind === 'sequence' ? node.items : node.branches
      for (const child of children) {
        total = saturating(total + positionsOf(child, caseFold, host, scratch))
        if (total === SATURATED) return total
      }
      return total
    }
    case 'repeat': {
      const copies = node.max === null ? Math.max(node.min, 1) : node.max
      return saturating(copies * positionsOf(node.body, caseFold, host, scratch))
    }
    case 'numberRange':
      return positionsOf(node.expansion, caseFold, host, scratch)
  }
}

export function patternPositions(node: PatternNode, caseFold: boolean, host: PatternHost): number {
  return positionsOf(node, caseFold, host, [])
}
