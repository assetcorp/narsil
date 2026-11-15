import { EVENT_TYPES } from '../events/types'
import { MAX_WEBHOOK_SECRET_BYTES, MIN_WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_PREFIX } from './constants'
import type { WebhookSettings } from './types'
import { SettingError, type VariableReader } from './variables'

const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const URL_VARIABLE = 'NARSIL_WEBHOOK_URL'
const SECRET_VARIABLE = 'NARSIL_WEBHOOK_SECRET'
const EVENTS_VARIABLE = 'NARSIL_WEBHOOK_EVENTS'
const SECRET_RULE = `must be ${WEBHOOK_SECRET_PREFIX} followed by the base64 of ${MIN_WEBHOOK_SECRET_BYTES} to ${MAX_WEBHOOK_SECRET_BYTES} bytes`

function decodeSecret(raw: string): Uint8Array {
  if (!raw.startsWith(WEBHOOK_SECRET_PREFIX)) throw new SettingError(SECRET_VARIABLE, SECRET_RULE)
  const encoded = raw.slice(WEBHOOK_SECRET_PREFIX.length)
  if (!STANDARD_BASE64.test(encoded) || encoded.length % 4 !== 0) throw new SettingError(SECRET_VARIABLE, SECRET_RULE)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw new SettingError(SECRET_VARIABLE, SECRET_RULE)
  if (bytes.length < MIN_WEBHOOK_SECRET_BYTES || bytes.length > MAX_WEBHOOK_SECRET_BYTES) {
    throw new SettingError(SECRET_VARIABLE, SECRET_RULE)
  }
  return new Uint8Array(bytes)
}

function readUrl(reader: VariableReader): string | undefined {
  const raw = reader.text(URL_VARIABLE)
  if (raw === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new SettingError(URL_VARIABLE, 'must be an absolute http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingError(URL_VARIABLE, 'must be an absolute http or https URL')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SettingError(URL_VARIABLE, 'must carry no user name or password')
  }
  return raw
}

function readEvents(reader: VariableReader): ReadonlySet<string> | null {
  const events = reader.list(EVENTS_VARIABLE)
  if (events === undefined) return null
  for (const event of events) {
    if (!EVENT_TYPES.has(event)) {
      throw new SettingError(EVENTS_VARIABLE, `must hold event types such as engine.workerCrash or task.finished`)
    }
  }
  return new Set(events)
}

export function readWebhook(reader: VariableReader, warnings: string[]): WebhookSettings | null {
  const url = readUrl(reader)
  const rawSecret = reader.text(SECRET_VARIABLE)
  const secret = rawSecret === undefined ? undefined : decodeSecret(rawSecret)
  const events = readEvents(reader)
  if (url === undefined) {
    for (const variable of [SECRET_VARIABLE, EVENTS_VARIABLE]) {
      if (reader.isSet(variable)) warnings.push(`${variable} takes effect only with ${URL_VARIABLE}, which is unset`)
    }
    return null
  }
  if (secret === undefined) throw new SettingError(SECRET_VARIABLE, `must be set with ${URL_VARIABLE}`)
  return { url, secret, events }
}
