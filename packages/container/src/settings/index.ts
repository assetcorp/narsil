import { hostname } from 'node:os'
import { isAbsolute } from 'node:path'
import { readEmbedders, readRerankers } from './adapters'
import {
  DEFAULT_DATA_DIR,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_LANGUAGE,
  LANGUAGE_NAME_PATTERN,
  MAX_HTTP_PORT,
  MIN_KEY_CHARACTERS,
  MIN_QUERY_SUGGESTIONS_KEY_BYTES,
} from './constants'
import { readLimits } from './limits'
import type {
  AccessKeys,
  ContainerSettings,
  CorsOrigins,
  EngineSettings,
  NetworkSettings,
  StorageSettings,
} from './types'
import { type Environment, SettingError, VariableReader } from './variables'
import { readWebhook } from './webhooks'

export type { ContainerSettings } from './types'
export { type Environment, SettingError } from './variables'

const ANY_ORIGIN = '*'

function readCors(reader: VariableReader): CorsOrigins | null {
  const origins = reader.list('NARSIL_CORS_ORIGINS')
  if (origins === undefined) return null
  if (origins.length === 1 && origins[0] === ANY_ORIGIN) return { kind: 'any' }
  for (const origin of origins) {
    let parsed: URL | null = null
    try {
      parsed = new URL(origin)
    } catch {}
    if (parsed === null || parsed.origin !== origin || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new SettingError('NARSIL_CORS_ORIGINS', 'must be * or a list of origins such as https://app.example.com')
    }
  }
  return { kind: 'list', origins }
}

function readKey(reader: VariableReader, variable: string): string | null {
  const key = reader.text(variable)
  if (key === undefined) return null
  if ([...key].length < MIN_KEY_CHARACTERS) {
    throw new SettingError(variable, `must hold at least ${MIN_KEY_CHARACTERS} characters`)
  }
  return key
}

function readKeys(reader: VariableReader): AccessKeys {
  const admin = readKey(reader, 'NARSIL_ADMIN_KEY')
  const read = readKey(reader, 'NARSIL_READ_KEY')
  if (admin !== null && admin === read) {
    throw new SettingError('NARSIL_READ_KEY', 'must differ from NARSIL_ADMIN_KEY')
  }
  return { admin, read }
}

function readNetwork(reader: VariableReader): NetworkSettings {
  return {
    host: reader.text('NARSIL_HTTP_HOST') ?? DEFAULT_HTTP_HOST,
    port: reader.wholeNumber('NARSIL_HTTP_PORT', { min: 1, max: MAX_HTTP_PORT }) ?? DEFAULT_HTTP_PORT,
    cors: readCors(reader),
    allowInsecure: reader.boolean('NARSIL_ALLOW_INSECURE') ?? false,
    instanceId: reader.text('NARSIL_INSTANCE_ID') ?? hostname(),
  }
}

function readStorage(reader: VariableReader, warnings: string[]): StorageSettings {
  const kind = reader.oneOf('NARSIL_STORAGE', ['filesystem', 'memory'] as const) ?? 'filesystem'
  const dataDir = reader.text('NARSIL_DATA_DIR') ?? DEFAULT_DATA_DIR
  if (!isAbsolute(dataDir)) throw new SettingError('NARSIL_DATA_DIR', 'must be an absolute path')
  const durabilityMode = reader.oneOf('NARSIL_DURABILITY_MODE', ['sync', 'async'] as const) ?? 'sync'
  if (kind === 'memory') {
    warnings.push('NARSIL_STORAGE is memory, so a restart loses every index')
  }
  return { kind, dataDir, durabilityMode }
}

function readEngine(reader: VariableReader): EngineSettings {
  const languages = reader.list('NARSIL_LANGUAGES') ?? [DEFAULT_LANGUAGE]
  for (const language of languages) {
    if (!LANGUAGE_NAME_PATTERN.test(language)) {
      throw new SettingError('NARSIL_LANGUAGES', 'must hold language module names such as english or haitian-creole')
    }
  }
  return {
    languages: [...new Set(languages)],
    workers: reader.wholeNumber('NARSIL_WORKERS', { min: 0 }),
    promotionThreshold: reader.wholeNumber('NARSIL_PROMOTION_THRESHOLD', { min: 1 }),
    allowRegex: reader.boolean('NARSIL_ALLOW_REGEX') ?? true,
  }
}

function readQuerySuggestions(reader: VariableReader, warnings: string[]): { key: string } | null {
  const enabled = reader.boolean('NARSIL_QUERY_SUGGESTIONS') ?? false
  const key = reader.text('NARSIL_QUERY_SUGGESTIONS_KEY')
  if (!enabled) {
    if (key !== undefined) {
      warnings.push('NARSIL_QUERY_SUGGESTIONS_KEY takes effect only while NARSIL_QUERY_SUGGESTIONS is true')
    }
    return null
  }
  if (key === undefined || Buffer.byteLength(key, 'utf8') < MIN_QUERY_SUGGESTIONS_KEY_BYTES) {
    throw new SettingError(
      'NARSIL_QUERY_SUGGESTIONS_KEY',
      `must be set to at least ${MIN_QUERY_SUGGESTIONS_KEY_BYTES} bytes in UTF-8 while NARSIL_QUERY_SUGGESTIONS is true`,
    )
  }
  return { key }
}

function requireCredentialRules(settings: ContainerSettings): void {
  const hasKey = settings.keys.admin !== null || settings.keys.read !== null
  if (!hasKey && !settings.network.allowInsecure) {
    throw new SettingError('NARSIL_ADMIN_KEY', 'or NARSIL_READ_KEY must be set, unless NARSIL_ALLOW_INSECURE is true')
  }
  if (!hasKey && settings.sync) {
    throw new SettingError('NARSIL_SYNC', 'can be true only with NARSIL_ADMIN_KEY or NARSIL_READ_KEY set')
  }
  if (!hasKey && settings.changes) {
    throw new SettingError('NARSIL_CHANGES', 'can be true only with NARSIL_ADMIN_KEY or NARSIL_READ_KEY set')
  }
}

export function readSettings(env: Environment): ContainerSettings {
  const reader = new VariableReader(env)
  const warnings: string[] = []
  const settings: ContainerSettings = {
    network: readNetwork(reader),
    keys: readKeys(reader),
    storage: readStorage(reader, warnings),
    engine: readEngine(reader),
    limits: readLimits(reader),
    embedders: readEmbedders(reader, warnings),
    rerankers: readRerankers(reader, warnings),
    sync: reader.boolean('NARSIL_SYNC') ?? false,
    changes: reader.boolean('NARSIL_CHANGES') ?? false,
    querySuggestions: readQuerySuggestions(reader, warnings),
    webhook: readWebhook(reader, warnings),
    build: { version: reader.text('NARSIL_BUILD_VERSION'), gitSha: reader.text('NARSIL_BUILD_GIT_SHA') },
    warnings,
  }
  requireCredentialRules(settings)
  for (const name of reader.unconsultedNames()) {
    warnings.push(`${name} is no variable of the container specification, so the startup program ignores it`)
  }
  return settings
}
