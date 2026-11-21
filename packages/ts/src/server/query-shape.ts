import { SORT_MODES } from '../core/ordering/sort-values'
import { ErrorCodes } from '../errors'
import { isPlainObject, type ValidationFailure } from './validation'

type Shape =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'choice'; values: readonly string[] }
  | { kind: 'scalars'; item: 'string' | 'number'; wanted: string }
  | { kind: 'items'; item: Shape }
  | {
      kind: 'object'
      fields: ReadonlyArray<readonly [string, Shape]>
      declared: ReadonlySet<string>
      required: ReadonlySet<string>
    }
  | { kind: 'record'; value: Shape }
  | { kind: 'either'; wanted: string; branches: Branches }
  | { kind: 'unchecked' }

interface Branches {
  string?: Shape
  number?: Shape
  boolean?: Shape
  object?: Shape
  list?: Shape
}

interface Mismatch {
  path: string
  wanted: string
  required: boolean
}

type Walked = { value: unknown } | { mismatch: Mismatch }

const STRING: Shape = { kind: 'string' }
const NUMBER: Shape = { kind: 'number' }
const BOOLEAN: Shape = { kind: 'boolean' }
const STRINGS: Shape = { kind: 'scalars', item: 'string', wanted: 'a list of strings' }
const NUMBERS: Shape = { kind: 'scalars', item: 'number', wanted: 'a list of numbers' }
const SORT_DIRECTION: Shape = { kind: 'choice', values: ['asc', 'desc'] }

function object(fields: ReadonlyArray<readonly [string, Shape]>, required: readonly string[] = []): Shape {
  return { kind: 'object', fields, declared: new Set(fields.map(([key]) => key)), required: new Set(required) }
}

const QUERY_SHAPE = object([
  ['term', STRING],
  ['fields', STRINGS],
  ['filters', { kind: 'unchecked' }],
  ['boost', { kind: 'record', value: NUMBER }],
  [
    'bm25',
    object([
      ['k1', NUMBER],
      ['b', NUMBER],
      [
        'fields',
        {
          kind: 'record',
          value: object([
            ['k1', NUMBER],
            ['b', NUMBER],
          ]),
        },
      ],
    ]),
  ],
  ['scoring', { kind: 'choice', values: ['local', 'dfs', 'broadcast'] }],
  ['minScore', NUMBER],
  [
    'termMatch',
    {
      kind: 'either',
      wanted: '"all", "any", or a number',
      branches: { string: { kind: 'choice', values: ['all', 'any'] }, number: NUMBER },
    },
  ],
  ['tolerance', NUMBER],
  ['prefixLength', NUMBER],
  ['prefix', BOOLEAN],
  ['partialWords', BOOLEAN],
  ['exact', BOOLEAN],
  [
    'facets',
    {
      kind: 'record',
      value: object([
        ['limit', NUMBER],
        ['sort', SORT_DIRECTION],
        [
          'ranges',
          {
            kind: 'items',
            item: object(
              [
                ['from', NUMBER],
                ['to', NUMBER],
              ],
              ['from', 'to'],
            ),
          },
        ],
      ]),
    },
  ],
  [
    'sort',
    {
      kind: 'either',
      wanted: 'an object keyed by field name, or a list of fields',
      branches: {
        object: { kind: 'record', value: SORT_DIRECTION },
        list: {
          kind: 'items',
          item: object(
            [
              ['field', STRING],
              ['direction', SORT_DIRECTION],
              ['mode', { kind: 'choice', values: SORT_MODES }],
            ],
            ['field', 'direction'],
          ),
        },
      },
    },
  ],
  ['limit', NUMBER],
  ['offset', NUMBER],
  ['searchAfter', STRING],
  [
    'highlight',
    object(
      [
        ['fields', STRINGS],
        ['preTag', STRING],
        ['postTag', STRING],
        ['maxSnippetLength', NUMBER],
      ],
      ['fields'],
    ),
  ],
  [
    'pinned',
    {
      kind: 'items',
      item: object(
        [
          ['docId', STRING],
          ['position', NUMBER],
        ],
        ['docId', 'position'],
      ),
    },
  ],
  ['mode', { kind: 'choice', values: ['vector', 'hybrid', 'fulltext'] }],
  [
    'vector',
    object(
      [
        ['field', STRING],
        ['value', NUMBERS],
        ['text', STRING],
        ['similarity', NUMBER],
        ['metric', { kind: 'choice', values: ['cosine', 'dotProduct', 'euclidean'] }],
        ['efSearch', NUMBER],
        ['oversample', NUMBER],
      ],
      ['field'],
    ),
  ],
  [
    'hybrid',
    object([
      ['strategy', { kind: 'choice', values: ['rrf', 'linear'] }],
      ['k', NUMBER],
      ['alpha', NUMBER],
      ['depth', NUMBER],
    ]),
  ],
  [
    'rerank',
    object(
      [
        ['adapter', STRING],
        ['fields', STRINGS],
        ['query', STRING],
        ['window', NUMBER],
      ],
      ['adapter', 'fields'],
    ),
  ],
  ['includeScores', BOOLEAN],
  ['includeScoreComponents', BOOLEAN],
  [
    'document',
    {
      kind: 'either',
      wanted: 'true, false, or an object',
      branches: {
        boolean: BOOLEAN,
        object: object([
          ['include', STRINGS],
          ['exclude', STRINGS],
          ['vectors', BOOLEAN],
        ]),
      },
    },
  ],
  [
    'group',
    object([
      ['fields', STRINGS],
      ['limit', NUMBER],
      ['maxPerGroup', NUMBER],
    ]),
  ],
])

function choices(values: readonly string[]): string {
  const quoted = values.map(value => `"${value}"`)
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`
  return `one of ${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`
}

function wanted(shape: Shape): string {
  switch (shape.kind) {
    case 'string':
      return 'a string'
    case 'number':
      return 'a number'
    case 'boolean':
      return 'true or false'
    case 'choice':
      return choices(shape.values)
    case 'scalars':
      return shape.wanted
    case 'items':
      return 'a list'
    case 'object':
      return 'an object'
    case 'record':
      return 'an object keyed by field name'
    case 'either':
      return shape.wanted
    case 'unchecked':
      return 'any value'
  }
}

function child(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`
}

function mismatch(path: string, shape: Shape, required = false): Walked {
  return { mismatch: { path, wanted: wanted(shape), required } }
}

function walkObject(value: unknown, shape: Extract<Shape, { kind: 'object' }>, path: string): Walked {
  if (!isPlainObject(value)) return mismatch(path, shape)
  const cleaned = new Map<string, unknown>()
  for (const [key, field] of shape.fields) {
    const given = value[key]
    if (given === null || given === undefined) {
      if (shape.required.has(key)) return mismatch(child(path, key), field, true)
      continue
    }
    const walked = walk(given, field, child(path, key))
    if ('mismatch' in walked) return walked
    cleaned.set(key, walked.value)
  }
  const entries: Array<[string, unknown]> = []
  for (const [key, given] of Object.entries(value)) {
    if (cleaned.has(key)) entries.push([key, cleaned.get(key)])
    else if (given !== null && !shape.declared.has(key)) entries.push([key, given])
  }
  return { value: Object.fromEntries(entries) }
}

function walkRecord(value: unknown, shape: Extract<Shape, { kind: 'record' }>, path: string): Walked {
  if (!isPlainObject(value)) return mismatch(path, shape)
  const entries: Array<[string, unknown]> = []
  for (const [key, given] of Object.entries(value)) {
    if (given === null) continue
    const walked = walk(given, shape.value, child(path, key))
    if ('mismatch' in walked) return walked
    entries.push([key, walked.value])
  }
  return { value: Object.fromEntries(entries) }
}

function walkItems(value: unknown, shape: Extract<Shape, { kind: 'items' }>, path: string): Walked {
  if (!Array.isArray(value)) return mismatch(path, shape)
  const items: unknown[] = []
  for (const [at, item] of value.entries()) {
    const walked = walk(item, shape.item, child(path, String(at)))
    if ('mismatch' in walked) return walked
    items.push(walked.value)
  }
  return { value: items }
}

function branchOf(value: unknown, branches: Branches): Shape | undefined {
  if (typeof value === 'string') return branches.string
  if (typeof value === 'number') return branches.number
  if (typeof value === 'boolean') return branches.boolean
  if (Array.isArray(value)) return branches.list
  if (isPlainObject(value)) return branches.object
  return undefined
}

function walkEither(value: unknown, shape: Extract<Shape, { kind: 'either' }>, path: string): Walked {
  const branch = branchOf(value, shape.branches)
  if (branch === undefined) return mismatch(path, shape)
  const walked = walk(value, branch, path)
  if ('mismatch' in walked && walked.mismatch.path === path) return mismatch(path, shape)
  return walked
}

function walk(value: unknown, shape: Shape, path: string): Walked {
  switch (shape.kind) {
    case 'string':
      return typeof value === 'string' ? { value } : mismatch(path, shape)
    case 'number':
      return typeof value === 'number' ? { value } : mismatch(path, shape)
    case 'boolean':
      return typeof value === 'boolean' ? { value } : mismatch(path, shape)
    case 'choice':
      return typeof value === 'string' && shape.values.includes(value) ? { value } : mismatch(path, shape)
    case 'scalars':
      return Array.isArray(value) && value.every(item => typeof item === shape.item) ? { value } : mismatch(path, shape)
    case 'items':
      return walkItems(value, shape, path)
    case 'object':
      return walkObject(value, shape, path)
    case 'record':
      return walkRecord(value, shape, path)
    case 'either':
      return walkEither(value, shape, path)
    case 'unchecked':
      return { value }
  }
}

export function checkQueryShape<T extends object>(params: T): { query: T } | { failure: ValidationFailure } {
  const walked = walk(params, QUERY_SHAPE, '')
  if ('mismatch' in walked) {
    const { path, wanted: shape, required } = walked.mismatch
    const verb = required ? 'is required and must be' : 'must be'
    const message = `Field "${path}" ${verb} ${shape}`
    const projection = path === 'document' || path.startsWith('document.')
    return { failure: projection ? { message, code: ErrorCodes.SEARCH_INVALID_FIELD } : { message } }
  }
  return { query: walked.value as T }
}
