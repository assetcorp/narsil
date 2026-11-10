import { ErrorCodes, encode, flattenSchema, NarsilError } from '#platform/suggestion-store-host'
import type { QuerySuggestionsSetting, QuerySuggestionsSource } from '../types/query-suggestions'
import type { SchemaDefinition } from '../types/schema'
import * as limits from './constants'
import { isGroup } from './phrase'
import { parseSchedule } from './schedule'

export type ResolvedSetting = Required<QuerySuggestionsSetting>

type NumericKey = Exclude<keyof QuerySuggestionsSetting, 'enabled' | 'fields' | 'schedule' | 'timeZone'>

interface Range {
  key: NumericKey
  wire: string
  fallback: number
  min: number
  max: number | NumericKey
}

const RANGES: readonly Range[] = [
  {
    key: 'minPeople',
    wire: 'min_people',
    fallback: limits.DEFAULT_MIN_PEOPLE,
    min: limits.MIN_MIN_PEOPLE,
    max: limits.MAX_MIN_PEOPLE,
  },
  {
    key: 'minResults',
    wire: 'min_results',
    fallback: limits.DEFAULT_MIN_RESULTS,
    min: limits.MIN_MIN_RESULTS,
    max: limits.MAX_MIN_RESULTS,
  },
  {
    key: 'retentionDays',
    wire: 'retention_days',
    fallback: limits.DEFAULT_RETENTION_DAYS,
    min: limits.MIN_RETENTION_DAYS,
    max: limits.MAX_RETENTION_DAYS,
  },
  {
    key: 'maxPhrasesPerDay',
    wire: 'max_phrases_per_day',
    fallback: limits.DEFAULT_MAX_PHRASES_PER_DAY,
    min: 1,
    max: limits.MAX_MAX_PHRASES_PER_DAY,
  },
  {
    key: 'maxPhrasesPerPerson',
    wire: 'max_phrases_per_person',
    fallback: limits.DEFAULT_MAX_PHRASES_PER_PERSON,
    min: 1,
    max: limits.MAX_MAX_PHRASES_PER_PERSON,
  },
  {
    key: 'maxPeoplePerDay',
    wire: 'max_people_per_day',
    fallback: limits.DEFAULT_MAX_PEOPLE_PER_DAY,
    min: 1,
    max: limits.MAX_MAX_PEOPLE_PER_DAY,
  },
  { key: 'maxGroups', wire: 'max_groups', fallback: limits.DEFAULT_MAX_GROUPS, min: 1, max: limits.MAX_MAX_GROUPS },
  { key: 'maxLength', wire: 'max_length', fallback: limits.DEFAULT_MAX_LENGTH, min: 1, max: limits.MAX_MAX_LENGTH },
  { key: 'minLetters', wire: 'min_letters', fallback: limits.DEFAULT_MIN_LETTERS, min: 1, max: 'maxLength' },
  { key: 'maxWords', wire: 'max_words', fallback: limits.DEFAULT_MAX_WORDS, min: 1, max: limits.MAX_MAX_WORDS },
  { key: 'maxDigits', wire: 'max_digits', fallback: limits.DEFAULT_MAX_DIGITS, min: 0, max: 'maxLength' },
  {
    key: 'maxMergePhrases',
    wire: 'max_merge_phrases',
    fallback: limits.DEFAULT_MAX_MERGE_PHRASES,
    min: 1,
    max: limits.MAX_MAX_MERGE_PHRASES,
  },
  {
    key: 'mergeMemoryBytes',
    wire: 'merge_memory_bytes',
    fallback: limits.DEFAULT_MERGE_MEMORY_BYTES,
    min: limits.MIN_MERGE_MEMORY_BYTES,
    max: limits.MAX_MERGE_MEMORY_BYTES,
  },
  {
    key: 'saveIntervalMs',
    wire: 'save_interval_ms',
    fallback: limits.DEFAULT_SAVE_INTERVAL_MS,
    min: limits.MIN_SAVE_INTERVAL_MS,
    max: limits.MAX_SAVE_INTERVAL_MS,
  },
  {
    key: 'resultChecksPerSecond',
    wire: 'result_checks_per_second',
    fallback: limits.DEFAULT_RESULT_CHECKS_PER_SECOND,
    min: 1,
    max: limits.MAX_RESULT_CHECKS_PER_SECOND,
  },
]

const SETTING_KEYS = new Set<string>(['enabled', 'fields', 'schedule', 'timeZone', ...RANGES.map(range => range.key)])

export function invalidSetting(message: string, details: Record<string, unknown> = {}): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, message, details)
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function knowsTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function resolveSetting(setting: QuerySuggestionsSetting): ResolvedSetting {
  const resolved: Record<string, unknown> = {
    enabled: setting.enabled,
    fields: [...setting.fields],
    schedule: setting.schedule ?? limits.DEFAULT_SCHEDULE,
    timeZone: setting.timeZone ?? limits.DEFAULT_TIME_ZONE,
  }
  for (const range of RANGES) resolved[range.key] = setting[range.key] ?? range.fallback
  return resolved as ResolvedSetting
}

function requireProducts(resolved: ResolvedSetting): void {
  if (resolved.maxPeoplePerDay * resolved.maxPhrasesPerPerson > limits.MAX_PERSON_PAIRS_PER_DAY) {
    invalidSetting(`maxPeoplePerDay times maxPhrasesPerPerson must stay at or below ${limits.MAX_PERSON_PAIRS_PER_DAY}`)
  }
  if (resolved.maxPhrasesPerDay * resolved.minPeople > limits.MAX_FILE_PEOPLE_PER_DAY) {
    invalidSetting(`maxPhrasesPerDay times minPeople must stay at or below ${limits.MAX_FILE_PEOPLE_PER_DAY}`)
  }
  if (resolved.maxMergePhrases * resolved.minPeople > limits.MAX_MERGE_PEOPLE) {
    invalidSetting(`maxMergePhrases times minPeople must stay at or below ${limits.MAX_MERGE_PEOPLE}`)
  }
}

export function validateSetting(raw: unknown): QuerySuggestionsSetting {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalidSetting('The query suggestions setting must be an object')
  }
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!SETTING_KEYS.has(key)) invalidSetting(`The query suggestions setting holds an unknown key "${key}"`, { key })
  }
  if (typeof input.enabled !== 'boolean') invalidSetting('The query suggestions setting needs a boolean "enabled"')
  const fields = input.fields
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > limits.MAX_FIELDS) {
    invalidSetting(`The query suggestions setting needs from 1 to ${limits.MAX_FIELDS} fields`)
  }
  const seen = new Set<string>()
  for (const field of fields) {
    if (typeof field !== 'string' || field.length === 0 || seen.has(field)) {
      invalidSetting('Each field of the query suggestions setting must be a distinct, non-empty path')
    }
    seen.add(field)
  }
  const setting: QuerySuggestionsSetting = { enabled: input.enabled, fields: [...seen] }
  for (const range of RANGES) {
    const value = input[range.key]
    if (value === undefined) continue
    if (!isWholeNumber(value)) invalidSetting(`${range.key} must be a whole number`, { key: range.key })
    setting[range.key] = value
  }
  const resolved = resolveSetting(setting)
  for (const range of RANGES) {
    const value = resolved[range.key]
    const max = typeof range.max === 'number' ? range.max : resolved[range.max]
    if (value < range.min || value > max) {
      invalidSetting(`${range.key} must be from ${range.min} to ${max}`, { key: range.key, value })
    }
  }
  requireProducts(resolved)
  if (input.schedule !== undefined) {
    if (typeof input.schedule !== 'string') invalidSetting('schedule must be a string')
    if (input.schedule !== limits.SCHEDULE_OFF && parseSchedule(input.schedule) === null) {
      invalidSetting('schedule must be "off" or a cron expression of five fields', { schedule: input.schedule })
    }
    setting.schedule = input.schedule
  }
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== 'string' || !knowsTimeZone(input.timeZone)) {
      invalidSetting('timeZone must name an IANA time zone', { timeZone: String(input.timeZone) })
    }
    setting.timeZone = input.timeZone
  }
  if (encode(settingToWire(setting)).byteLength > limits.MAX_SETTING_BYTES) {
    invalidSetting(`The query suggestions setting must encode to at most ${limits.MAX_SETTING_BYTES} bytes`)
  }
  return setting
}

export function requireFieldsInSchema(setting: QuerySuggestionsSetting, schema: SchemaDefinition): void {
  const flat = flattenSchema(schema)
  for (const field of setting.fields) {
    const type = flat[field]
    if (type !== 'string' && type !== 'string[]') {
      invalidSetting(`Field "${field}" must be a string or string[] field of the schema`, { field })
    }
  }
}

export function settingToWire(setting: QuerySuggestionsSetting): Record<string, unknown> {
  const wire: Record<string, unknown> = { enabled: setting.enabled, fields: [...setting.fields] }
  for (const range of RANGES) {
    const value = setting[range.key]
    if (value !== undefined) wire[range.wire] = value
  }
  if (setting.schedule !== undefined) wire.schedule = setting.schedule
  if (setting.timeZone !== undefined) wire.time_zone = setting.timeZone
  return wire
}

export function settingFromWire(raw: unknown): QuerySuggestionsSetting {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalidSetting('The stored query suggestions setting is not a map')
  }
  const wire = raw as Record<string, unknown>
  const camel: Record<string, unknown> = {}
  const byWire = new Map<string, string>([
    ['enabled', 'enabled'],
    ['fields', 'fields'],
    ['schedule', 'schedule'],
    ['time_zone', 'timeZone'],
    ...RANGES.map(range => [range.wire, range.key] as [string, string]),
  ])
  for (const [key, value] of Object.entries(wire)) {
    const camelKey = byWire.get(key)
    if (camelKey === undefined) invalidSetting(`The stored query suggestions setting holds an unknown key "${key}"`)
    camel[camelKey] = value
  }
  return validateSetting(camel)
}

export function validateSource(raw: unknown): QuerySuggestionsSource {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalidSetting('The suggestions index marker must be a map')
  }
  const { index, group, ...rest } = raw as Record<string, unknown>
  if (Object.keys(rest).length > 0) invalidSetting('The suggestions index marker holds an unknown key')
  if (typeof index !== 'string' || index.length === 0 || index.length > limits.MAX_SOURCE_INDEX_NAME_LENGTH) {
    invalidSetting('The suggestions index marker needs the name of its source index')
  }
  if (!isGroup(group)) {
    invalidSetting('The suggestions index marker needs a valid group')
  }
  return { index, group }
}
