import type { ExpressionOperator } from '../../core/pattern-index/types'

export type ClassName = 'digit' | 'word' | 'space'

export type SetItem =
  | { readonly kind: 'member'; readonly codePoint: number }
  | { readonly kind: 'range'; readonly low: number; readonly high: number }
  | { readonly kind: 'class'; readonly name: ClassName }

export type PatternNode =
  | { readonly kind: 'literal'; readonly codePoint: number }
  | { readonly kind: 'any' }
  | { readonly kind: 'class'; readonly name: ClassName }
  | { readonly kind: 'set'; readonly negated: boolean; readonly items: readonly SetItem[] }
  | { readonly kind: 'assert'; readonly mask: number }
  | { readonly kind: 'sequence'; readonly items: readonly PatternNode[] }
  | { readonly kind: 'choice'; readonly branches: readonly PatternNode[] }
  | { readonly kind: 'repeat'; readonly body: PatternNode; readonly min: number; readonly max: number | null }
  | { readonly kind: 'numberRange'; readonly expansion: PatternNode }

export interface ExpressionLabel {
  readonly operator: ExpressionOperator
  readonly fieldPath: string | null
}
