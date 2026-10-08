import { ErrorCodes, NarsilError } from '../../errors'
import type { FieldType, TextFieldOption } from '../../types/schema'
import { VECTOR_PATTERN } from './shared'

export type BaseFieldType =
  | 'string'
  | 'string[]'
  | 'verbatim'
  | 'verbatim[]'
  | 'number'
  | 'number[]'
  | 'boolean'
  | 'boolean[]'
  | 'enum'
  | 'enum[]'
  | 'geopoint'
  | 'vector'

export interface ParsedFieldType {
  readonly type: FieldType
  readonly base: BaseFieldType
  readonly sortable: boolean
  readonly pattern: boolean
  readonly partial: boolean
  readonly dimension: number
}

const FIELD_OPTION_ORDER: readonly TextFieldOption[] = ['sortable', 'pattern', 'partial']

const OPTIONS_BY_BASE: Readonly<Record<BaseFieldType, readonly string[]>> = {
  string: FIELD_OPTION_ORDER,
  'string[]': FIELD_OPTION_ORDER,
  verbatim: ['sortable'],
  'verbatim[]': ['sortable'],
  number: [],
  'number[]': [],
  boolean: [],
  'boolean[]': [],
  enum: [],
  'enum[]': [],
  geopoint: [],
  vector: [],
}

const TYPE_SEPARATOR = ':'

function isNamedBase(name: string): name is Exclude<BaseFieldType, 'vector'> {
  return name !== 'vector' && Object.hasOwn(OPTIONS_BY_BASE, name)
}

function describeAllowedOptions(baseName: string, allowed: readonly string[]): string {
  if (allowed.length === 0) return `the "${baseName}" type has no options`
  const quoted = allowed.map(option => `"${option}"`)
  if (quoted.length === 1) return `the only option of the "${baseName}" type is ${quoted[0]}`
  return `the options of the "${baseName}" type are ${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`
}

function invalidType(path: string, type: string, message: string): never {
  throw new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, message, { field: path, type })
}

function parseBase(baseName: string, path: string, type: string): { base: BaseFieldType; dimension: number } {
  if (isNamedBase(baseName)) return { base: baseName, dimension: 0 }
  const vectorMatch = VECTOR_PATTERN.exec(baseName)
  if (vectorMatch === null) {
    invalidType(path, type, `Field "${path}" has an unsupported type: "${type}"`)
  }
  const dimension = Number.parseInt(vectorMatch[1], 10)
  if (dimension <= 0) {
    throw new NarsilError(
      ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION,
      `Vector field "${path}" must have a positive dimension, got ${dimension}`,
      { field: path, dimension },
    )
  }
  return { base: 'vector', dimension }
}

export function parseFieldType(type: string, path: string): ParsedFieldType {
  const separatorIndex = type.indexOf(TYPE_SEPARATOR)
  const baseName = separatorIndex === -1 ? type : type.slice(0, separatorIndex)
  const { base, dimension } = parseBase(baseName, path, type)
  const allowed = OPTIONS_BY_BASE[base]
  const options = new Set<string>()

  if (separatorIndex !== -1) {
    for (const option of type.slice(separatorIndex + 1).split(TYPE_SEPARATOR)) {
      if (!allowed.includes(option)) {
        invalidType(
          path,
          type,
          `Field "${path}" has type "${type}" with the option "${option}", but ${describeAllowedOptions(baseName, allowed)}`,
        )
      }
      if (options.has(option)) {
        invalidType(path, type, `Field "${path}" has the "${option}" option twice in type "${type}"`)
      }
      options.add(option)
    }
  }

  const ordered = FIELD_OPTION_ORDER.filter(option => options.has(option))
  const verbatim = base === 'verbatim' || base === 'verbatim[]'
  return {
    type: [baseName, ...ordered].join(TYPE_SEPARATOR) as FieldType,
    base,
    sortable: options.has('sortable'),
    pattern: verbatim || options.has('pattern'),
    partial: options.has('partial'),
    dimension,
  }
}

export function parsedTypeOf(type: string | undefined): ParsedFieldType | undefined {
  if (type === undefined) return undefined
  try {
    return parseFieldType(type, '')
  } catch {
    return undefined
  }
}

export function withSortableOption(parsed: ParsedFieldType): string {
  if (parsed.sortable) return parsed.type
  const separatorIndex = parsed.type.indexOf(TYPE_SEPARATOR)
  const baseName = separatorIndex === -1 ? parsed.type : parsed.type.slice(0, separatorIndex)
  return parseFieldType(`${baseName}${TYPE_SEPARATOR}sortable${parsed.type.slice(baseName.length)}`, '').type
}

export function isListBase(base: BaseFieldType): boolean {
  return base.endsWith('[]')
}

export function isWordIndexedBase(base: BaseFieldType): boolean {
  return base === 'string' || base === 'string[]'
}

export function isSingleStringFieldType(fieldType: string): boolean {
  return parsedTypeOf(fieldType)?.base === 'string'
}

export function isWordIndexedFieldType(fieldType: string): boolean {
  const parsed = parsedTypeOf(fieldType)
  return parsed !== undefined && isWordIndexedBase(parsed.base)
}

export function isStringValuedBase(base: BaseFieldType): boolean {
  return base === 'string' || base === 'string[]' || base === 'verbatim' || base === 'verbatim[]'
}
