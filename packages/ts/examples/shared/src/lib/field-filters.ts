export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'string[]'
  | 'number[]'
  | 'boolean[]'
  | 'enum[]'

export interface SchemaField {
  path: string
  type: SchemaFieldType
}

export interface SchemaLeaf {
  path: string
  type: string
}

export type FilterOperatorId =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'nin'
  | 'startsWith'
  | 'endsWith'
  | 'containsAll'
  | 'matchesAny'
  | 'exists'
  | 'notExists'
  | 'isEmpty'
  | 'isNotEmpty'

export interface FilterRule {
  id: string
  field: string
  operator: FilterOperatorId
  value: string
  upperValue: string
}

export type OperatorArity = 'none' | 'one' | 'two' | 'list'

const FIELD_TYPES = new Set<string>([
  'string',
  'number',
  'boolean',
  'enum',
  'string[]',
  'number[]',
  'boolean[]',
  'enum[]',
])

const TEXT_OPERATORS: FilterOperatorId[] = ['eq', 'ne', 'startsWith', 'endsWith', 'in', 'nin']
const NUMBER_OPERATORS: FilterOperatorId[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between']
const BOOLEAN_OPERATORS: FilterOperatorId[] = ['eq', 'ne']
const ARRAY_OPERATORS: FilterOperatorId[] = ['matchesAny', 'containsAll']
const PRESENCE_OPERATORS: FilterOperatorId[] = ['exists', 'notExists']
const EMPTINESS_OPERATORS: FilterOperatorId[] = ['isEmpty', 'isNotEmpty']

export const OPERATOR_LABELS: Record<FilterOperatorId, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  between: 'between',
  in: 'is one of',
  nin: 'is none of',
  startsWith: 'starts with',
  endsWith: 'ends with',
  containsAll: 'holds all of',
  matchesAny: 'holds any of',
  exists: 'has a value',
  notExists: 'has no value',
  isEmpty: 'is empty',
  isNotEmpty: 'holds something',
}

const ARITY_BY_OPERATOR: Record<FilterOperatorId, OperatorArity> = {
  eq: 'one',
  ne: 'one',
  gt: 'one',
  gte: 'one',
  lt: 'one',
  lte: 'one',
  between: 'two',
  in: 'list',
  nin: 'list',
  startsWith: 'one',
  endsWith: 'one',
  containsAll: 'list',
  matchesAny: 'list',
  exists: 'none',
  notExists: 'none',
  isEmpty: 'none',
  isNotEmpty: 'none',
}

export function operatorArity(operator: FilterOperatorId): OperatorArity {
  return ARITY_BY_OPERATOR[operator]
}

export function isArrayField(type: SchemaFieldType): boolean {
  return type.endsWith('[]')
}

export function operatorsFor(type: SchemaFieldType): FilterOperatorId[] {
  if (isArrayField(type)) return [...ARRAY_OPERATORS, ...PRESENCE_OPERATORS, ...EMPTINESS_OPERATORS]
  if (type === 'number') return [...NUMBER_OPERATORS, ...PRESENCE_OPERATORS]
  if (type === 'boolean') return [...BOOLEAN_OPERATORS, ...PRESENCE_OPERATORS]
  if (type === 'string') return [...TEXT_OPERATORS, ...PRESENCE_OPERATORS, ...EMPTINESS_OPERATORS]
  return [...TEXT_OPERATORS, ...PRESENCE_OPERATORS]
}

export function flattenSchemaLeaves(schema: Record<string, unknown>, prefix = ''): SchemaLeaf[] {
  const leaves: SchemaLeaf[] = []
  for (const [name, type] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${name}` : name
    if (typeof type === 'string') {
      leaves.push({ path, type })
      continue
    }
    if (typeof type === 'object' && type !== null && !Array.isArray(type)) {
      leaves.push(...flattenSchemaLeaves(type as Record<string, unknown>, path))
    }
  }
  return leaves
}

export function isVectorType(type: string): boolean {
  return type.startsWith('vector[')
}

export function filterableFields(leaves: readonly SchemaLeaf[]): SchemaField[] {
  const fields: SchemaField[] = []
  for (const leaf of leaves) {
    if (FIELD_TYPES.has(leaf.type)) fields.push({ path: leaf.path, type: leaf.type as SchemaFieldType })
  }
  return fields
}

export function flattenSchemaFields(schema: Record<string, unknown>, prefix = ''): SchemaField[] {
  return filterableFields(flattenSchemaLeaves(schema, prefix))
}

export function sortableFieldPaths(fields: SchemaField[]): Set<string> {
  const paths = new Set<string>()
  for (const field of fields) {
    if (!isArrayField(field.type)) paths.add(field.path)
  }
  return paths
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

function coerce(raw: string, type: SchemaFieldType): string | number | boolean | null {
  if (type === 'number' || type === 'number[]') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (type === 'boolean' || type === 'boolean[]') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return null
  }
  return raw
}

function buildComparison(rule: FilterRule, type: SchemaFieldType): Record<string, unknown> | null {
  const arity = operatorArity(rule.operator)

  if (arity === 'none') return { [rule.operator]: true }

  if (arity === 'list') {
    const values = splitList(rule.value)
      .map(entry => coerce(entry, type))
      .filter(entry => entry !== null)
    if (values.length === 0) return null
    return { [rule.operator]: values }
  }

  if (arity === 'two') {
    const low = coerce(rule.value, type)
    const high = coerce(rule.upperValue, type)
    if (typeof low !== 'number' || typeof high !== 'number') return null
    return { between: [Math.min(low, high), Math.max(low, high)] }
  }

  if (rule.value.trim().length === 0) return null
  const value = coerce(rule.value, type)
  if (value === null) return null
  return { [rule.operator]: value }
}

export function isRuleComplete(rule: FilterRule, fields: SchemaField[]): boolean {
  const field = fields.find(entry => entry.path === rule.field)
  if (!field) return false
  return buildComparison(rule, field.type) !== null
}

export function buildFilterExpression(rules: FilterRule[], fields: SchemaField[]): Record<string, unknown> | undefined {
  const clauses: Array<Record<string, unknown>> = []

  for (const rule of rules) {
    const field = fields.find(entry => entry.path === rule.field)
    if (!field) continue
    const comparison = buildComparison(rule, field.type)
    if (comparison === null) continue
    clauses.push({ fields: { [rule.field]: comparison } })
  }

  if (clauses.length === 0) return undefined
  if (clauses.length === 1) return clauses[0]
  return { and: clauses }
}

export function describeRule(rule: FilterRule): string {
  const arity = operatorArity(rule.operator)
  const label = OPERATOR_LABELS[rule.operator]
  if (arity === 'none') return `${rule.field} ${label}`
  if (arity === 'two') return `${rule.field} ${label} ${rule.value} and ${rule.upperValue}`
  return `${rule.field} ${label} ${rule.value}`
}
