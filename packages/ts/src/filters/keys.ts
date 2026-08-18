import type {
  ArrayFilter,
  ComparisonFilter,
  FilterExpression,
  GeoPolygonFilter,
  GeoRadiusFilter,
  PresenceFilter,
  StringFilter,
} from '../types/filters'

export const FILTER_EXPRESSION_KEYS = ['fields', 'and', 'or', 'not'] as const

export const FIELD_FILTER_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'lt',
  'gte',
  'lte',
  'between',
  'in',
  'nin',
  'startsWith',
  'endsWith',
  'containsAll',
  'matchesAny',
  'size',
  'exists',
  'notExists',
  'isEmpty',
  'isNotEmpty',
  'radius',
  'polygon',
] as const

type ListedExpressionKey = (typeof FILTER_EXPRESSION_KEYS)[number]
type DeclaredExpressionKey = keyof FilterExpression

type ListedOperator = (typeof FIELD_FILTER_OPERATORS)[number]
type DeclaredOperator =
  | keyof ComparisonFilter
  | keyof StringFilter
  | keyof ArrayFilter
  | keyof PresenceFilter
  | keyof GeoRadiusFilter
  | keyof GeoPolygonFilter

type MustBeNever<T extends never> = T

export type FilterExpressionKeysMatchType =
  | MustBeNever<Exclude<DeclaredExpressionKey, ListedExpressionKey>>
  | MustBeNever<Exclude<ListedExpressionKey, DeclaredExpressionKey>>

export type FieldFilterOperatorsMatchTypes =
  | MustBeNever<Exclude<DeclaredOperator, ListedOperator>>
  | MustBeNever<Exclude<ListedOperator, DeclaredOperator>>
