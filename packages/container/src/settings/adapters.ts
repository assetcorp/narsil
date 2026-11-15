import { validateHeaderValue } from 'node:http'
import {
  ADAPTER_NAME_PATTERN,
  DEFAULT_ADAPTER_MAX_RETRIES,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  DEFAULT_EMBEDDER_TRANSFORMERS_MODEL,
  DEFAULT_RERANKER_MAX_DOCUMENTS_PER_REQUEST,
  DEFAULT_RERANKER_TRANSFORMERS_MODEL,
} from './constants'
import type { EmbedderSetting, RerankerSetting } from './types'
import { SettingError, type VariableReader } from './variables'

type Family = 'EMBEDDER' | 'RERANKER'

const REMOTE_ONLY_EMBEDDER_FIELDS = ['URL', 'API_KEY', 'TIMEOUT_MS', 'MAX_RETRIES'] as const
const REMOTE_ONLY_RERANKER_FIELDS = [
  'URL',
  'API_KEY',
  'TIMEOUT_MS',
  'MAX_RETRIES',
  'MAX_DOCUMENTS_PER_REQUEST',
] as const

function infixOf(name: string): string {
  return name.toUpperCase().replaceAll('-', '_')
}

function namesOf(reader: VariableReader, listVariable: string): Array<{ name: string; infix: string }> {
  const names = reader.list(listVariable) ?? []
  const byInfix = new Map<string, string>()
  for (const name of names) {
    if (!ADAPTER_NAME_PATTERN.test(name)) {
      throw new SettingError(listVariable, 'must hold names that match [a-z0-9][a-z0-9_-]{0,63}')
    }
    const infix = infixOf(name)
    if (byInfix.has(infix)) {
      throw new SettingError(listVariable, `must hold no two names with the same infix, as ${infix} shows`)
    }
    byInfix.set(infix, name)
  }
  return [...byInfix].map(([infix, name]) => ({ name, infix }))
}

function httpUrl(reader: VariableReader, variable: string): string | undefined {
  const raw = reader.text(variable)
  if (raw === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new SettingError(variable, 'must be an absolute http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingError(variable, 'must be an absolute http or https URL')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.href.includes('?') || parsed.href.includes('#')) {
    throw new SettingError(variable, 'must be a base URL without credentials, a query, or a fragment')
  }
  return parsed.href
}

function nonBlankText(reader: VariableReader, variable: string): string | undefined {
  const value = reader.text(variable)
  if (value !== undefined && value.trim().length === 0)
    throw new SettingError(variable, 'must contain non-space characters')
  return value
}

function apiKeyOf(reader: VariableReader, variable: string): string | undefined {
  const key = nonBlankText(reader, variable)
  if (key === undefined) return undefined
  try {
    validateHeaderValue('authorization', `Bearer ${key}`)
  } catch {
    throw new SettingError(variable, 'must be a valid HTTP header value')
  }
  return key
}

function required<T>(value: T | undefined, variable: string, rule: string): T {
  if (value === undefined) throw new SettingError(variable, rule)
  return value
}

function warnUnusedFields(
  reader: VariableReader,
  family: Family,
  infix: string,
  fields: readonly string[],
  remoteKind: string,
  warnings: string[],
): void {
  for (const field of fields) {
    const variable = `NARSIL_${family}_${infix}_${field}`
    if (reader.isSet(variable)) {
      warnings.push(`${variable} applies only to the ${remoteKind} kind, so the startup program ignores it`)
    }
  }
}

function readEmbedder(reader: VariableReader, name: string, infix: string, warnings: string[]): EmbedderSetting {
  const prefix = `NARSIL_EMBEDDER_${infix}_`
  const kind = required(
    reader.oneOf(`${prefix}KIND`, ['openai', 'transformers'] as const),
    `${prefix}KIND`,
    'must be set to openai or transformers',
  )
  const url = httpUrl(reader, `${prefix}URL`)
  const apiKey = apiKeyOf(reader, `${prefix}API_KEY`)
  const model = nonBlankText(reader, `${prefix}MODEL`)
  const dimensions = required(
    reader.wholeNumber(`${prefix}DIMENSIONS`, { min: 1 }),
    `${prefix}DIMENSIONS`,
    'must be set to a whole number of at least 1',
  )
  const timeoutMs = reader.wholeNumber(`${prefix}TIMEOUT_MS`, { min: 1 }) ?? DEFAULT_ADAPTER_TIMEOUT_MS
  const maxRetries = reader.wholeNumber(`${prefix}MAX_RETRIES`, { min: 0 }) ?? DEFAULT_ADAPTER_MAX_RETRIES
  if (kind === 'transformers') {
    warnUnusedFields(reader, 'EMBEDDER', infix, REMOTE_ONLY_EMBEDDER_FIELDS, 'openai', warnings)
    const chosen = model ?? DEFAULT_EMBEDDER_TRANSFORMERS_MODEL
    return { name, kind, url: undefined, apiKey: undefined, model: chosen, dimensions, timeoutMs, maxRetries }
  }
  return {
    name,
    kind,
    url: required(url, `${prefix}URL`, 'must be set for the openai kind'),
    apiKey,
    model: required(model, `${prefix}MODEL`, 'must be set for the openai kind'),
    dimensions,
    timeoutMs,
    maxRetries,
  }
}

function readReranker(reader: VariableReader, name: string, infix: string, warnings: string[]): RerankerSetting {
  const prefix = `NARSIL_RERANKER_${infix}_`
  const kind = required(
    reader.oneOf(`${prefix}KIND`, ['http', 'transformers'] as const),
    `${prefix}KIND`,
    'must be set to http or transformers',
  )
  const url = httpUrl(reader, `${prefix}URL`)
  const apiKey = apiKeyOf(reader, `${prefix}API_KEY`)
  const model = nonBlankText(reader, `${prefix}MODEL`)
  const timeoutMs = reader.wholeNumber(`${prefix}TIMEOUT_MS`, { min: 1 }) ?? DEFAULT_ADAPTER_TIMEOUT_MS
  const maxRetries = reader.wholeNumber(`${prefix}MAX_RETRIES`, { min: 0 }) ?? DEFAULT_ADAPTER_MAX_RETRIES
  const maxDocumentsPerRequest =
    reader.wholeNumber(`${prefix}MAX_DOCUMENTS_PER_REQUEST`, { min: 1 }) ?? DEFAULT_RERANKER_MAX_DOCUMENTS_PER_REQUEST
  if (kind === 'transformers') {
    warnUnusedFields(reader, 'RERANKER', infix, REMOTE_ONLY_RERANKER_FIELDS, 'http', warnings)
    const chosen = model ?? DEFAULT_RERANKER_TRANSFORMERS_MODEL
    return {
      name,
      kind,
      url: undefined,
      apiKey: undefined,
      model: chosen,
      timeoutMs,
      maxRetries,
      maxDocumentsPerRequest,
    }
  }
  return {
    name,
    kind,
    url: required(url, `${prefix}URL`, 'must be set for the http kind'),
    apiKey,
    model: required(model, `${prefix}MODEL`, 'must be set for the http kind'),
    timeoutMs,
    maxRetries,
    maxDocumentsPerRequest,
  }
}

export function readEmbedders(reader: VariableReader, warnings: string[]): EmbedderSetting[] {
  return namesOf(reader, 'NARSIL_EMBEDDERS').map(({ name, infix }) => readEmbedder(reader, name, infix, warnings))
}

export function readRerankers(reader: VariableReader, warnings: string[]): RerankerSetting[] {
  return namesOf(reader, 'NARSIL_RERANKERS').map(({ name, infix }) => readReranker(reader, name, infix, warnings))
}
